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
MARKETMIX_CHANNEL_ID = os.getenv("MARKETMIX_CHANNEL_ID", "").strip()
MARKETMIX_STORE_URL = "https://t.me/marketmixua_bot"
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
        "VITRANO Shop Assistant\n\n"
        "Надішліть /post, оберіть магазин і надішліть фото товару з готовим описом. "
        "Бот сам опублікує товар із кнопкою переходу до магазину.\n\n"
        "/cancel — скасувати створення\n"
        "/id — показати ваш Telegram ID"
    )


def handle_callback(callback):
    user = callback.get("from", {})
    user_id = user.get("id")
    data = callback.get("data", "")
    callback_id = callback.get("id")
    chat_id = (callback.get("message") or {}).get("chat", {}).get("id")

    if not is_admin(user_id):
        api("answerCallbackQuery", {"callback_query_id": callback_id, "text": "Немає доступу."})
        return

    if data.startswith("color:"):
        style = data.split(":", 1)[1]
        if style not in {"primary", "success", "danger"}:
            api("answerCallbackQuery", {"callback_query_id": callback_id, "text": "Невідомий колір."})
            return
        session = sessions.get(str(user_id))
        if not session or session.get("stage") != "color":
            api("answerCallbackQuery", {"callback_query_id": callback_id, "text": "Почніть із /post."})
            return
        session["button_style"] = style
        session["stage"] = "photo"
        api("answerCallbackQuery", {"callback_query_id": callback_id, "text": "Колір обрано."})
        names = {"primary": "синій", "success": "зелений", "danger": "червоний"}
        send(chat_id, f"Обрано {names[style]} колір. Тепер надішліть фото товару з готовим підписом українською.")
        return

    channels = {
        "publish:vitrano": {
            "channel_id": CHANNEL_ID,
            "channel_name": "VITRANO",
            "store_url": "https://vitrano-storefront.onrender.com/",
            "button": "🛍 Відкрити VITRANO"
        },
        "publish:marketmix": {
            "channel_id": MARKETMIX_CHANNEL_ID,
            "channel_name": "Market Mix",
            "store_url": MARKETMIX_STORE_URL,
            "button": "🛒 Перейти в магазин"
        }
    }
    selected = channels.get(data)
    if not selected:
        api("answerCallbackQuery", {"callback_query_id": callback_id})
        return
    if not selected["channel_id"]:
        api("answerCallbackQuery", {"callback_query_id": callback_id, "text": "Цей канал ще не налаштований."})
        return

    sessions[str(user_id)] = {
        "stage": "color",
        "channel_id": selected["channel_id"],
        "channel_name": selected["channel_name"],
        "store_url": selected["store_url"],
        "button": selected["button"]
    }
    api("answerCallbackQuery", {"callback_query_id": callback_id, "text": selected["channel_name"]})
    send(chat_id, "Оберіть колір кнопки магазину:", {"inline_keyboard": [
        [{"text": "🔵 Синій", "callback_data": "color:primary"}],
        [{"text": "🟢 Зелений", "callback_data": "color:success"}],
        [{"text": "🔴 Червоний", "callback_data": "color:danger"}]
    ]})


def handle_message(message):
    chat = message.get("chat", {})
    user = message.get("from", {})
    chat_id = chat.get("id")
    user_id = user.get("id")
    text = (message.get("text") or "").strip()

    if is_admin(user_id):
        origin = message.get("forward_origin") or {}
        forwarded_chat = origin.get("chat") if origin.get("type") == "channel" else message.get("forward_from_chat")
        if forwarded_chat and forwarded_chat.get("type") == "channel":
            channel_id = forwarded_chat.get("id")
            title = forwarded_chat.get("title", "канал")
            send(chat_id, f"Канал: {title}\nЧисловой ID: {channel_id}")
            return

    if text == "/id":
        send(chat_id, f"Ваш Telegram ID: {user_id}")
        return

    if not is_admin(user_id):
        send(chat_id, "Цей бот призначений для адміністратора магазину.")
        return

    if text.startswith("/start") or text.startswith("/help"):
        send(chat_id, help_text())
        return

    if text.startswith("/cancel"):
        sessions.pop(str(user_id), None)
        send(chat_id, "Створення скасовано.")
        return

    if text == "/post":
        sessions.pop(str(user_id), None)
        keyboard = []
        if CHANNEL_ID:
            keyboard.append([{"text": "VITRANO", "callback_data": "publish:vitrano"}])
        if MARKETMIX_CHANNEL_ID:
            keyboard.append([{"text": "MARKET MIX", "callback_data": "publish:marketmix"}])
        if not keyboard:
            send(chat_id, "Канали ще не налаштовані.")
            return
        send(chat_id, "Де публікуємо товар?", {"inline_keyboard": keyboard})
        return

    # Keep the previous channel-specific commands as aliases.
    if text.startswith("/post_marketmix"):
        if not MARKETMIX_CHANNEL_ID:
            send(chat_id, "Канал Market Mix ще не налаштований.")
            return
        sessions[str(user_id)] = {
            "stage": "photo", "channel_id": MARKETMIX_CHANNEL_ID,
            "channel_name": "Market Mix", "store_url": MARKETMIX_STORE_URL,
            "button": "🛒 Перейти в магазин"
        }
        send(chat_id, "MARKET MIX: надішліть фото товару з готовим підписом українською.")
        return

    if text == "/post_vitrano":
        if not CHANNEL_ID:
            send(chat_id, "Канал VITRANO ще не налаштований.")
            return
        sessions[str(user_id)] = {
            "stage": "photo", "channel_id": CHANNEL_ID,
            "channel_name": "VITRANO", "store_url": "https://vitrano-storefront.onrender.com/",
            "button": "🛍 Відкрити VITRANO"
        }
        send(chat_id, "VITRANO: надішліть фото товару з готовим підписом українською.")
        return

    session = sessions.get(str(user_id))
    if not session:
        send(chat_id, "Надішліть /post, щоб створити публікацію.")
        return

    if session.get("stage") == "photo":
        photos = message.get("photo") or []
        caption = (message.get("caption") or "").strip()
        if not photos or not caption:
            send(chat_id, "Надішліть фото товару та додайте опис у підписі до фото.")
            return
        if len(caption) > 1024:
            send(chat_id, "Опис задовгий. Скоротіть його до 1024 символів і надішліть фото ще раз.")
            return
        try:
            payload = {
                "chat_id": session["channel_id"],
                "photo": photos[-1]["file_id"],
                "caption": caption,
                "reply_markup": {
                    "inline_keyboard": [[{
                        "text": session["button"],
                        "url": session["store_url"],
                        "style": session.get("button_style", "primary")
                    }]]
                }
            }
            api("sendPhoto", payload)
            channel_name = session["channel_name"]
            sessions.pop(str(user_id), None)
            send(chat_id, f"Опубліковано в {channel_name}. Кнопка магазину додана автоматично.")
        except Exception as exc:
            log.error("Failed to publish (%s)", type(exc).__name__)
            send(chat_id, "Не вдалося опублікувати. Перевірте права бота адміністратора в каналі.")
        return


@app.post(WEBHOOK_PATH)
def telegram_webhook():
    if not WEBHOOK_SECRET or request.headers.get("X-Telegram-Bot-Api-Secret-Token") != WEBHOOK_SECRET:
        return jsonify({"ok": False}), 403

    update = request.get_json(silent=True) or {}
    channel_post = update.get("channel_post")
    if channel_post and ADMIN_ID:
        try:
            channel = channel_post.get("chat", {})
            if channel.get("type") == "channel":
                send(ADMIN_ID, f"Канал: {channel.get('title', 'без названия')}\\nЧисловой ID: {channel.get('id')}")
        except Exception as exc:
            log.error("Channel ID notification failed (%s)", type(exc).__name__)
    callback = update.get("callback_query")
    if callback:
        try:
            handle_callback(callback)
        except Exception as exc:
            log.error("Callback handling failed (%s)", type(exc).__name__)
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
            "allowed_updates": ["message", "channel_post", "callback_query"],
            "drop_pending_updates": False
        })
        log.info("Telegram webhook configured: %s", bool(result))
    except Exception as exc:
        log.error("Webhook setup failed (%s)", type(exc).__name__)


if __name__ == "__main__":
    configure_webhook()
    port = int(os.getenv("PORT", "10000"))
    app.run(host="0.0.0.0", port=port)
