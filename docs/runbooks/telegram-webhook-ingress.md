# Telegram Webhook Ingress

## Flood control

Commands, callbacks, and pending-selection replies share a fixed-window D1
counter. Private chats use a chat-scoped key. Groups use an actor-scoped key
plus a higher chat-wide ceiling.

Each admission is one conditional `cache` upsert with `RETURNING`; it either
increments the existing window or starts a new window at the exact expiry
boundary. This avoids lost increments when Telegram delivers webhook updates
concurrently. The counter remains an advisory availability guard: if D1 cannot
execute the statement or return a valid count, the webhook logs
`command-flood` and fails open for that update.

## Callback acknowledgements

Every callback path calls Telegram's `answerCallbackQuery` method to dismiss
the client spinner. Non-OK Bot API responses are drained and emit one
structured warning with `action=answer-callback-query`, `statusCode`, and a
bounded `errorClass`. The log never includes callback, chat, user, bot-token,
or response-body data, and acknowledgement failures are not retried inline.

When investigating callback reports, filter Worker logs on
`action=answer-callback-query`, then group by `statusCode` and `errorClass`.
`rate_limit` and `server_error` usually indicate transient Telegram-side
pressure; `auth_error` requires checking the deployed bot token; repeated
`bad_request` responses warrant checking callback payload construction and
age.
