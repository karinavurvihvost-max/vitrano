# VITRANO Telegram Bot

Standalone Telegram channel publishing bot. Secrets are provided only through Render environment variables.

## Required Render environment variables
- BOT_TOKEN — token from BotFather (never commit it)
- ADMIN_ID — numeric Telegram user ID of the store owner, obtainable by messaging the bot with /id
- CHANNEL_ID — public channel username like @your_channel_username, or numeric channel ID

## Render service
Runtime: Python
Build command: pip install -r bot/requirements.txt
Start command: python bot/main.py
Health endpoint: /health

## Admin workflow
1. Send /start to the bot.
2. Send /post.
3. Send a product photo with a caption containing the verified title, description, price, and stock status.
4. Send one button per line: Label | https://exact-product-url | success/danger/primary
5. Styles are passed to Telegram Bot API; client support and appearance may vary.
6. The bot publishes the photo, caption and URL buttons to CHANNEL_ID.

Use only real product URLs and verified prices/stock. Do not commit tokens or other secrets.
