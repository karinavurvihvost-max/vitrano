import os
import time
import hashlib
import logging
from urllib.parse import urlparse

import requests
from flask import Flask, jsonify, request

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
log = logging.getLogger("vitrano-bot")

BOT_TOKEN = os.getenv("BOT_TOKEN", "").strip()
ADMIN_ID = os.getenv("ADMIN_ID", "").strip()
CHANNEL_ID = os.getenv("CHANNEL_ID", "").strip()
RENDER_URL = os.getenv("RENDER_EXTERNAL_URL", "https://vitrano-telegram-bot.onrender.com").strip().rstrip("/")
WEBHOOK_PATH = "/telegram/webhook"
WEBHOOK_SECRET = hashlib.sha256((BOT_TOKEN + ":vitrano-webhook").encode()).hexdigest()[:40] if BOT_TOKEN else ""
API = f"https://api.telegram.org/bot{BOT_TOKEN}" if BOT_TOKEN else ""
app = Flask(__name__)
sessions = {}


@app.get("/")
@app.get("/health")
def health():
    return jsonify({"service": "vitrano-telegram-bot", "status": "ok" if BOT_TOKEN else "waiting_for_bot_token"})


def api(method, payload=None, timeout=35):
    if not BOT_TOKEN:
        raise RuntimeError("BOT_TOKEN is not configured")
    try:
        response = requests.post(f"{API}/{method}", json=payload or {}, timeout=timeout)
        response.raise_for_status()
        data = response.json()
    except requests.RequestException as exc:
        status = getattr(getattr(exc, "response", None), "status_code", None)
        raise RuntimeError(f"Telegram request failed (HTTP {status or 'network error'}).") from None
    if not data.get("ok"):
        # Telegram descriptions are safe to log; never log request URLs.
        raise RuntimeError(data.get("description", "Telegram API error"))
    return data.get("result")


def send(chat_id, text, reply_markup=None):
    payload = {"chat_id": chat_id, "text": text}
    if reply_markup:
        payload["reply_markup"] = reply_markup
    return api("sendMessage", payload)


def is_admin(user_id):
    return bool(ADMIN_ID) and str(user_id) == ADMIN_ID


def safe_url(value):
    try:
        parsed = urlparse(value.strip())
        return parsed.scheme == "https" and bool(parsed.netloc)
    except Exception:
        return False


def help_text():
    return (
        "VITRANO Shop Assistant\\n\\n"
        "Команди адміністратора:\\n"
        "/post — створити публікацію товару\\n"
        "/cancel — скасувати створення\\n"
        "/id — показати ваш Telegram ID\\n\\n"
        "Після /post надішліть фото товару з підписом. "
        "Потім надішліть кнопки — по одній на рядок у форматі:\\n"
        "🛒 Купити | https://посилання-на-товар | success\\n"
        "🔥 Акція | https://посилання-на-акцію | danger\\n"
        "🌐 Відкрити сайт | https://vitrano-storefront.onrender.com/ | primary\\n\\n"
        "Стилі: success (зелений), danger (червоний), primary (синій). "
        "Відображення кольорів залежить від версії Telegram."
    )


def handle_message(message):
    chat = message.get("chat", {})
    user = message.get("from", {})
    chat_id = chat.get("id")
    user_id = user.get("id")
    text = (message.get("text") or "").strip()

    if text == "/id":
        send(chat_id, f"Ваш Telegram ID: {user_id}\\nПередайте це число власнику бота для налаштування ADMIN_ID.")
        return

    if not is_admin(user_id):
        send(chat_id, "Цей бот призначений для адміністратора магазину VITRANO.")
        return

    if text.startswith("/start") or text.startswith("/help"):
        send(chat_id, help_text())
        return
    if text.startswith("/cancel"):
        sessions.pop(str(user_id), None)
        send(chat_id, "Створення публікації скасовано.")
        return
    if text.startswith("/post"):
        if not CHANNEL_ID:
            send(chat_id, "Бот ще не налаштований: власник має додати CHANNEL_ID у змінні середовища Render.")
            return
        sessions[str(user_id)] = {"stage": "photo"}
        send(chat_id, "Надішліть фото товару з підписом українською: назва, короткий опис, ціна та наявність. Не вказуйте ціну, якщо її не перевірили на сайті.")
        return

    session = sessions.get(str(user_id))
    if not session:
        send(chat_id, "Вітаю! Надішліть /post, щоб створити товарну публікацію, або /help для інструкції.")
        return

    if session["stage"] == "photo":
        photos = message.get("photo") or []
        caption = (message.get("caption") or "").strip()
        if not photos or not caption:
            send(chat_id, "Потрібно надіслати фото товару та додати опис у підписі до фото.")
            return
        session["photo"] = photos[-1]["file_id"]
        session["caption"] = caption[:1024]
        session["stage"] = "buttons"
        send(chat_id,
             "Тепер надішліть кнопки — кожну з нового рядка у форматі:\\n"
             "🛒 Купити | https://точне-посилання-на-товар | success\\n"
             "🔥 Акція | https://точне-посилання-на-акцію | danger\\n"
             "🌐 Відкрити сайт | https://vitrano-storefront.onrender.com/ | primary\\n\\n"
             "Достатньо однієї кнопки «Купити». Посилання мають бути справжніми HTTPS-адресами. "
             "Щоб опублікувати без кнопок, надішліть /skip.")
        return

    if session["stage"] == "buttons":
        rows = []
        if text != "/skip":
            for line in text.splitlines():
                parts = [p.strip() for p in line.split("|")]
                if len(parts) != 3:
                    send(chat_id, "Невірний формат. Кожен рядок: Назва | https://посилання | success/danger/primary. Надішліть ще раз або /skip.")
                    return
                label, url, style = parts
                if not label or len(label) > 64 or not safe_url(url) or style not in {"success", "danger", "primary"}:
                    send(chat_id, "Перевірте назву, HTTPS-посилання та стиль кнопки: success, danger або primary.")
                    return
                rows.append([{"text": label, "url": url, "style": style}])
            if not rows:
                send(chat_id, "Додайте хоча б одну кнопку або надішліть /skip.")
                return
        try:
            markup = {"inline_keyboard": rows} if rows else None
            payload = {"chat_id": CHANNEL_ID, "photo": session["photo"], "caption": session["caption"]}
            if markup:
                payload["reply_markup"] = markup
            api("sendPhoto", payload)
            sessions.pop(str(user_id), None)
            send(chat_id, "Готово: публікацію надіслано до каналу VITRANO. Перевірте, чи фото, текст, кнопки та посилання відображаються правильно.")
        except Exception as exc:
            log.error("Failed to publish (%s)", type(exc).__name__)
            send(chat_id, "Не вдалося опублікувати. Перевірте токен, CHANNEL_ID, права бота та посилання. Деталі помилки приховано з міркувань безпеки.")
        return


@app.post(WEBHOOK_PATH)
def telegram_webhook():
    if not WEBHOOK_SECRET or request.headers.get("X-Telegram-Bot-Api-Secret-Token") != WEBHOOK_SECRET:
        return jsonify({"ok": False}), 403

    update = request.get_json(silent=True) or {}
    message = update.get("message")
    if message:
        try:
            handle_message(message)
        except Exception as exc:
            log.error("Message handling failed (%s)", type(exc).__name__)
            # Acknowledge the update to avoid an endless retry loop.
    return jsonify({"ok": True})


def configure_webhook():
    if not BOT_TOKEN:
        log.error("BOT_TOKEN is not configured")
        return
    if not RENDER_URL.startswith("https://"):
        log.error("RENDER_EXTERNAL_URL must be an HTTPS URL")
        return
    try:
        result = api("setWebhook", {
            "url": RENDER_URL + WEBHOOK_PATH,
            "secret_token": WEBHOOK_SECRET,
            "allowed_updates": ["message"],
            "drop_pending_updates": False
        })
        log.info("Telegram webhook configured: %s", bool(result))
    except Exception as exc:
        log.error("Webhook setup failed (%s)", type(exc).__name__)


if __name__ == "__main__":
    configure_webhook()
    port = int(os.getenv("PORT", "10000"))
    app.run(host="0.0.0.0", port=port)
