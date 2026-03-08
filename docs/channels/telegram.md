# Telegram Channel

Telegram is Cobrain's primary user interface. The bot runs on [grammy](https://grammy.dev) with `@grammyjs/runner` for long-polling and concurrent update handling.

## Setup

### 1. Create The Bot

1. Open Telegram and message [@BotFather](https://t.me/BotFather)
2. Run `/newbot`
3. Choose the bot name and username
4. Copy the token into `.env` as `TELEGRAM_BOT_TOKEN`

### 2. Configure Access

```env
TELEGRAM_BOT_TOKEN=123456789:ABC-DEF1234ghIkl-zyx57W2v1u123ew11
MY_TELEGRAM_ID=123456789
```

Only `MY_TELEGRAM_ID` is allowed to use the bot.

### 3. Register Command Menu

Send this to BotFather:

```text
/setcommands
```

Then paste:

```text
start - Start the bot
help - Show available commands
status - Show bot status
clear - Reset the current session
restart - Restart the bot
mode - Change permission mode
lang - Change language
```

## Commands

### `/start`

Shows the welcome message.

### `/help`

Displays the localized help text and command overview.

### `/status`

Shows runtime status, current base path, and user-level usage stats.

### `/clear`

Clears the current chat session and resets the saved session state.

### `/restart`

Restarts the running process. This is mainly useful on self-hosted deployments.

### `/mode`

Opens an inline keyboard for `strict`, `smart`, and `yolo` permission modes.

### `/lang`

Lets you switch the bot language between English and Turkish.

## Direct Messages

Any non-command message is routed to the main Cobrain chat flow.

Typical flow:

1. Authorization check
2. Session and memory lookup
3. Agent execution
4. Telegram response delivery
5. Persistence to the user database

## Permission Prompts

When a tool call needs approval, Cobrain sends an inline prompt in Telegram. Approving continues execution; denying cancels the action.

## Reliability Notes

- The bot uses grammy runner for concurrent update processing.
- Pending tool approvals are cleaned up on shutdown.
- Telegram command descriptions are re-registered when the language changes.

## Best Practices

1. Use `/clear` when changing topics completely.
2. Use `/mode` to tighten or relax tool approval behavior.
3. Use `/lang` before long conversations if you want responses localized.
4. Keep `MY_TELEGRAM_ID` scoped to a single trusted account.
