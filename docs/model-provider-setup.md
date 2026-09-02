# Connecting a self-hosted OpenAI-compatible model to pi

pi talks to any OpenAI-completions-compatible endpoint by adding a provider
block to `~/.pi/agent/models.json` and enabling it in `~/.pi/agent/settings.json`.
This is a generic walkthrough for wiring up a self-hosted reasoning model
(written against a vLLM-served Qwen3 model, but the same steps apply to any
OpenAI-compatible server).

## 1. Verify what the server actually serves — don't trust the label

Before writing any config, confirm the model ID your server reports live.
The name someone gave the deployment (a nickname, a shorthand) is often not
the exact string the `/v1/chat/completions` API expects in the `model` field.

```sh
curl -s http://YOUR_HOST:PORT/v1/models | jq .
```

Use the `id` field from that response verbatim as the model `id` in your
provider config — don't guess it from the deployment name.

## 2. Add the provider block

In `~/.pi/agent/models.json` (create it if it doesn't exist), add an entry
under `providers`. See `config/models.example.json` in this repo for a
filled-in template. The important fields:

- `baseUrl` — your server's OpenAI-compatible endpoint, ending in `/v1`
- `api: "openai-completions"` — the wire format pi should speak
- `apiKey` — most self-hosted servers don't check this; `"dummy-key"` is fine
  unless yours enforces one
- `compat` — quirks your specific server has relative to a "pure" OpenAI API
  (see below)

## 3. Enable it

Add `"<provider-name>/<model-id>"` to `enabledModels` in
`~/.pi/agent/settings.json` so it shows up in pi's model picker (`Ctrl+P` /
`--models`).

## 4. The reasoning/thinking quirk to watch for

Many self-hosted reasoning models (Qwen3 family included) expect the
thinking toggle nested under `chat_template_kwargs`, not as a top-level
request parameter:

```json
{
  "model": "your-model-id",
  "messages": [...],
  "chat_template_kwargs": { "enable_thinking": true }
}
```

A top-level `enable_thinking` field is silently ignored by many of these
servers — the request succeeds, but thinking never actually turns on and you
won't get an error telling you why. `"thinkingFormat": "qwen-chat-template"`
in the `compat` block tells pi to nest the flag correctly. If you're
integrating a different model family, verify this directly:

```sh
curl -s http://YOUR_HOST:PORT/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "your-model-id",
    "messages": [{"role": "user", "content": "test"}],
    "chat_template_kwargs": {"enable_thinking": true}
  }' | jq .
```

Check the response for actual reasoning/thinking content before assuming the
top-level flag would have worked.

## 5. Sanity-check end to end

```sh
pi --model <provider-name>/<model-id> --no-session -p "reply with exactly: ok"
```

If that returns `ok`, the provider is wired correctly. If it hangs, times
out, or errors, re-check `baseUrl` and that the server is reachable from
where pi runs (not just from your own machine, if the server is on an
internal network).

## Troubleshooting a colleague's "can't connect" report

If someone else on your team can't connect to the same server:

1. Confirm they can reach the host at all: `curl http://YOUR_HOST:PORT/v1/models`
   from their machine. If this fails, it's a network/VPN/firewall issue, not
   a pi config issue.
2. Confirm their `models.json` provider block matches yours exactly —
   `baseUrl`, `api`, and `compat` all matter; a typo in any of them produces
   confusing downstream errors rather than a clear "wrong config" message.
3. Confirm the model `id` they configured matches what `/v1/models` reports
   live on the server right now — deployments get renamed/redeployed and the
   served ID can drift from what's written in a shared doc.
