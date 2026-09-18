# Running it on your machine

Five steps. Nothing here needs prior terminal experience beyond copy-paste.

## 1. Install Node 22 or newer

Check what you have:

```
node --version
```

If it prints `v22.` or higher, skip ahead.

**If it says the command is not recognised, Node is not installed.**

### Windows

In PowerShell:

```
winget install OpenJS.NodeJS.LTS
winget install Git.Git
```

Then **close PowerShell and open a new window.** The installer adds Node to your
PATH, but only new terminals pick that up — running `node --version` in the same
window will still fail even after a successful install.

No `winget`? Download the installers instead:
[Node LTS](https://nodejs.org) and [Git for Windows](https://git-scm.com/download/win),
then reopen PowerShell.

### macOS

```
brew install node git
```

Or download the installer from [nodejs.org](https://nodejs.org).

Node 22 matters: this project reads your key from a `.env` file using a feature
older versions do not have.

### Windows: if npm is "blocked by execution policy"

PowerShell refuses to run `.ps1` scripts by default, and npm ships as one:

```
npm : Невозможно загрузить файл C:\Program Files\nodejs\npm.ps1 ...
npm : cannot be loaded because running scripts is disabled on this system ...
```

Node is installed correctly — PowerShell is just blocking the wrapper. Three ways
out, least invasive first:

1. **Use `npm.cmd` instead of `npm`.** The `.cmd` shim is not a PowerShell
   script, so the policy does not apply: `npm.cmd install`, `npm.cmd test`,
   `npm.cmd run verify:live`.
2. **Use Command Prompt** (search "cmd") instead of PowerShell. Plain `npm`
   works there.
3. **Allow local scripts for your user**, then reopen PowerShell:
   ```
   Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
   ```
   This affects your account only, and still requires downloaded scripts to be
   signed.

## 2. Get the code

```
git clone https://github.com/feedddosever/keepyourselfalive
cd keepyourselfalive
git checkout claude/wizardly-darwin-ndhujg
npm install
```

`npm install` takes a minute or two and prints a lot. That is normal.

## 3. Check it works without any credentials

```
npm test
npm run demo
```

94 tests should pass, and the demo prints the firewall walkthrough. If these work,
the project is installed correctly.

## 4. Put your KeeperHub key in a file

Get the key from KeeperHub: **Settings → API Keys → Organisation**. It starts
with `kh_`. A `wfb_` key is for webhooks and will be rejected.

Copy the example file and paste your key into it:

macOS / Linux:

```
cp .env.example .env
```

Windows PowerShell:

```
copy .env.example .env
notepad .env
```

Then open `.env` in any text editor and replace `kh_paste_your_key_here` with
your real key, so the line reads:

```
KH_API_KEY=kh_your_actual_key
```

Save it. `.env` is in `.gitignore`, so the key never reaches the repository.

## 5. Run the verification

```
npm run verify:live
```

That is the whole command — no environment variables, no export, nothing
platform-specific. It reads the key from `.env`.

### What success looks like

```
verifying the Lucid × KeeperHub integration on http://127.0.0.1:3210

  ok   Lucid serves its agent card  name=summarizer
  ok   Lucid rejects a malformed Idempotency-Key  invalid_idempotency_key
  ok   a valid key settles through KeeperHub  0x7d8d…
  ok   the same key replays instead of paying twice  replayed=true sameHash=true

  transaction  https://sepolia.basescan.org/tx/0x…
  identifier   pay_verify1758…
  block        46952…

all four checks passed. The integration works end to end.
```

Open that transaction link. That is a real payment your Lucid agent settled.

### If a check fails

Copy the **entire** output, including the `--- server log ---` section at the
bottom, and send it over. The common causes:

| Symptom | Cause |
|---|---|
| `KH_API_KEY is not set` | `.env` missing, or the key line still says `kh_paste_your_key_here` |
| `401 Unauthorized` | The key is wrong, expired, or is a `wfb_` webhook key |
| `insufficient_balance` | The org wallet ran out of Base Sepolia ETH; top it up |
| `Host not in allowlist` | Your network blocks `app.keeperhub.com` — try another connection |
| `node : ... not recognized` (Windows) | Node is not installed, or PowerShell was not reopened after installing |
| `npm.ps1 ... running scripts is disabled` (Windows) | PowerShell execution policy — use `npm.cmd`, or see step 1 |

## Running the agent by itself

For the video, you will want the agent running so you can curl it:

```
npm run agent
```

Then, in a second terminal:

**macOS / Linux:**

```
curl http://localhost:3000/.well-known/agent-card.json

curl -X POST http://localhost:3000/entrypoints/summarize/invoke \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: short' \
  -d '{"text":"hi"}'

curl -X POST http://localhost:3000/entrypoints/summarize/invoke \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: pay_lucid_demo_0001x' \
  -d '{"text":"KeeperHub settles what Lucid admits."}'
```

**Windows PowerShell** — `curl` there is an alias for a different command and the
backslash line-continuations do not work, so use these instead:

```
irm http://localhost:3000/.well-known/agent-card.json

irm http://localhost:3000/entrypoints/summarize/invoke -Method Post -ContentType 'application/json' -Headers @{'Idempotency-Key'='short'} -Body '{"text":"hi"}'

irm http://localhost:3000/entrypoints/summarize/invoke -Method Post -ContentType 'application/json' -Headers @{'Idempotency-Key'='pay_lucid_demo_0001x'} -Body '{"text":"KeeperHub settles what Lucid admits."}'
```

PowerShell throws a red error on the deliberate failure rather than printing the
body. To see Lucid's actual message, wrap it:

```
try { irm http://localhost:3000/entrypoints/summarize/invoke -Method Post -ContentType 'application/json' -Headers @{'Idempotency-Key'='short'} -Body '{"text":"hi"}' } catch { $_.ErrorDetails.Message }
```

The second one should fail with `invalid_idempotency_key` — that is Lucid's own
validation, and showing it is the strongest moment in the demo. The third should
settle and return a transaction hash. Run the third one twice: the second time
comes back with the same hash and `replayed: true`.

Stop the agent with Ctrl+C.
