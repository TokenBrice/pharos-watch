# Telegram Webhook Ingress

## Flood control

Commands, callbacks, and pending-selection replies share a fixed-window D1
counter. Private chats use a chat-scoped key. Groups with an actor ID use
actor and higher chat-wide ceilings; without one, the private-sized chat cap applies.

Each evaluated scope uses one conditional `cache` upsert with `RETURNING`; it either
increments the existing window or starts a new window at the exact expiry
boundary. This avoids lost increments when Telegram delivers webhook updates
concurrently. If D1 cannot execute a scope's statement or return a valid count,
the webhook logs `command-flood`. Admission requires at least one successfully
evaluated scope and no evaluated scope blocking the update. All scopes failing
denies admission with a best-effort busy reply; a private chat has only one
scope, so its counter failure denies the update. A group may still be admitted
when one scope fails and the other evaluates as allowed.

## Callback acknowledgements

Callback acknowledgements use Telegram's `answerCallbackQuery` to dismiss
the spinner; repeated flood denials after the first notice skip it. Non-OK responses are drained and emit one
structured warning with `action=answer-callback-query`, `statusCode`, and a
bounded `errorClass`. The log never includes callback, chat, user, bot-token,
or response-body data, and acknowledgement failures are not retried inline.

When investigating callback reports, filter Worker logs on
`action=answer-callback-query`, then group by `statusCode` and `errorClass`.
`rate_limit` and `server_error` usually indicate transient Telegram-side
pressure; `auth_error` requires checking the deployed bot token; repeated
`bad_request` responses warrant checking callback payload construction and
age.
