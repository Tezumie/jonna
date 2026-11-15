# The headless host: its wire

The backend also builds as a program with no window (`ide-host`, D428). This is the protocol it
speaks with whatever drives it: the command-line agent's Node process today. The TypeScript
side is `src/core/ipc/streamTransport.ts`; the Rust side is `src-tauri/src/host/`.

## Carrier

A reliable ordered byte stream: the host process's stdin/stdout (the command-line agent), or a
TCP connection on loopback (`--listen`). The host writes nothing else to stdout; logs go to stderr.

## Frame

Every message, both directions:

```
[u32 LE headerLength][u32 LE bodyLength][header: UTF-8 JSON, headerLength bytes][body: bodyLength raw bytes]
```

`bodyLength` is 0 for ordinary messages. A frame's header is one JSON object. Maximum header
64 MiB, maximum body 1 GiB; a larger frame is a protocol error and closes the connection.

## Client -> host

- Request: `{ "id": <positive integer>, "method": "<command name>", "params": { ...args } }`
  - `method` is the backend command's name exactly as the desktop front end calls it
    (`fs_read`, `git_status`, ...). `params` is the same args object the desktop front end passes,
    camelCase keys, same value shapes. Omitted `params` means `{}`.
  - A channel argument is passed as `{ "__channel": <positive integer> }`, the id chosen by the
    client, unique per connection for the connection's life.
  - A command that takes a raw body on the desktop (`fs_write`, `encoding_encode`,
    `encoding_guess`, `attachment_save`, `speech_transcribe`): the bytes are the frame's body and
    the header is `{ "id", "method", "raw": true, "headers": { "<name>": "<string>" } }`.
    Header names are compared lower-case.
- Notification (no `id`): `{ "method": "$/channelClose", "params": { "channel": <id> } }`
  The client will no longer read that channel. The host makes later sends on it fail the same way
  a send fails on the desktop when the page is gone.
- Reserved requests:
  - `$/hello` first, before anything else: `{ "id": 1, "method": "$/hello", "params": { "protocol": 1, "client": "<kind>", "token": "<string, TCP only>" } }`
    -> `{ "id": 1, "result": { "protocol": 1, "version": "<app version>", "os": "windows|macos|linux", "pid": <n>, "commands": ["...every command the host answers..."] } }`
    A wrong protocol or token answers an error and closes.
  - `$/shutdown`: the host answers `{ "id", "result": null }`, runs its shutdown (kills children,
    flushes stores) and exits 0. End of stdin does the same without an answer.

## Host -> client

- Result: `{ "id": <request id>, "result": <JSON value> }`
- Raw result (the commands that return bytes on the desktop): `{ "id", "raw": true }` with the
  bytes as the body.
- Error: `{ "id", "error": <the command's serialized error> }`. For the app's own error type this
  is `{ "code": "<one of the existing codes>", "message": "<text>" }`, exactly what the desktop
  front end receives. Protocol-level failures use `code` `"Invalid"` (bad params, unknown
  method -> message `unknown command: <name>`), `"Unknown"` otherwise.
- Channel message: `{ "channel": <id>, "data": <JSON value> }`, or for raw channel sends
  `{ "channel": <id>, "raw": true }` with a body.
  - Ordered per channel, in send order. A command's channel messages sent before it returns
    arrive before its result is not guaranteed; clients must not rely on it (the desktop
    doesn't guarantee it either).
- Channel end: `{ "channel": <id>, "end": true }`, sent once when the host has dropped every
  handle to that channel (nothing more will ever be sent on it), so the client can forget the id.
  Not sent for a channel the client closed with `$/channelClose`.
- Requests are answered in any order; many may be in flight.

## Semantics that must match the desktop

- Missing optional args are `None`. Unknown args are ignored.
- Arg names are camelCase on the wire unless the Rust command says `rename_all = "snake_case"`.
- Sync Rust commands run one at a time, in the order their requests arrived on the connection
  (`pty_write`, `pty_resize`: keystrokes can't overtake each other), on a thread of their own;
  async ones run on the runtime, many at once. Answers still come in any order.
- One host process serves one client connection at a time and one workspace session. A second
  TCP connection while one is open is refused (v1).
- Desktop-only commands (windows, native dialogs through the window, the embedded browser,
  screenshots of the web view, drag out, the updater) are absent from `commands` and answer
  `{ "code": "Invalid", "message": "unknown command: <name>" }`.
