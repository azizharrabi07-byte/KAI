---
name: write-like-me
description: Draft text in the user's own voice by building and applying a persisted voice profile learned from their real writing samples. Use this skill when asked to write, draft, ghostwrite, or rewrite something "as me", "in my voice", "how I would say it", or when a draft sounds generic and needs to sound like the user.
---

# Write Like Me Skill

## Purpose
Produce text that reads as though the user wrote it, by extracting a durable voice
profile from samples of their real writing and drafting against that profile
instead of against a generic register.

## When to use
Use this skill when the user asks for something written or rewritten in their own
voice: emails, Slack messages, posts, docs, replies, bios, proposals. Also use it
when the user says a draft "doesn't sound like me". Do not use it for writing that
must sound institutional rather than personal, for code, or for anything where the
user is not the named author.

## Inputs

**Mode 1 - build or update the profile**
- 5 samples minimum, 10 or more preferred, of writing the user actually sent or
  published, unedited by anyone else
- ideally grouped by channel (email, Slack, LinkedIn, docs, texts), because voice
  shifts by channel
- optional: samples the user explicitly disowns ("this one isn't me")

**Mode 2 - draft**
- the existing voice profile
- what to write: audience, channel, purpose, length, and the facts to include
- optional: the message being replied to, or a rough draft to convert

## Output

**Mode 1** writes or updates the profile at `~/.claude/write-like-me/voice-profile.md`
using the schema below, then reports the three or four most distinctive traits found
and asks the user to confirm or correct them.

```md
# Voice Profile - <user>
Built <date> from <n> samples: <channel breakdown>. Status: provisional | confirmed

## Structure
Sentence length: <mean>, range <low>-<high>. Fragments: <yes/no, how often>.
Paragraph length: <n sentences>. Lists vs prose: <bias>.

## Diction
Contractions: <rate>. Register: <plain | technical | formal>.
Recurring words and constructions: <list>.
Never uses: <list>.

## Punctuation and mechanics
<em dash, semicolon, parens, ellipsis, exclamation, capitalization, emoji habits>

## Openers and closers
Opens with: <pattern>. Signs off with: <pattern>. Greeting convention: <pattern>.

## Stance
Directness: <blunt | hedged>. Hedging phrases used: <list>.
Humor: <type, frequency>. Asks vs tells: <bias>.

## Channel variants
- Email: <deltas from the above>
- Slack: <deltas>
- <other>: <deltas>

## Declared rules
<any style spec the user supplied, plus each conflict with observed behavior and
how it was resolved for each channel>

## Evidence
<3-5 verbatim lines from the samples that best demonstrate the voice>
```

**Mode 2** returns the draft alone, in plain text, ready to paste - no preamble, no
"here's your draft", no commentary above it. Below the draft, add a short block:
- any facts invented or assumed, listed explicitly
- any place the profile gave no guidance and a judgment call was made

## Constraints

**Building the profile**
- read the samples before writing anything about them; never infer a voice from a
  description of the voice
- strip pasted AI output from samples before analyzing - forwarded model responses,
  comparison tables, arrow glyphs, and em-dash-heavy blocks are not the user's prose
  and will corrupt the profile
- when the user also supplies a declared style spec, treat it as a second source and
  rank it below observed behavior; record every conflict between the two and resolve
  each explicitly by channel rather than averaging them
- extract observable, checkable traits, not vibes: average and range of sentence
  length, contraction rate, punctuation habits, opener and closer patterns,
  recurring words and constructions, paragraph length, list-versus-prose bias,
  hedging rate, profanity, capitalization and greeting conventions
- record what the user never does, which is as diagnostic as what they do
- note the channel each trait came from; do not blend a Slack voice into an email
- if fewer than 5 samples exist, say the profile is provisional and say so again
  the first time it is used
- keep the profile under roughly 400 words of directives; a bloated profile is
  ignored in practice

**Drafting**
- match the profile's structural habits first (sentence length, paragraph size,
  openers), because structure carries voice more than word choice does
- never introduce facts, numbers, commitments, dates, or opinions the user did not
  supply - if the shape of the sentence needs a detail that does not exist, leave a
  bracketed gap rather than inventing one
- strip constructions the user never uses, including the common assistant tells:
  "I hope this finds you well", "delve", "leverage" as a verb, "it's worth noting",
  tricolons, and closing summary sentences that restate the message
- before returning the draft, audit it line by line against the profile and fix
  what does not match; do not show the audit unless asked
- when the request needs a register the profile has no sample of, say so in one
  line and name the nearest channel used as a substitute
- on user correction, update the profile file, not just the current draft

**Safety**
- the profile is personal data: keep it in the user's home directory, never commit
  it to a repository, never paste its contents into a shared document
- only write in the voice of the user themselves; refuse to build a profile that
  imitates a third party for signature, attribution, or approval purposes

## Examples
- Ingest 12 sent emails and 20 Slack messages, produce a voice profile, and report
  that the user opens with the ask, never greets by name internally, and averages
  11-word sentences
- Turn three bullet points into a client email in the user's voice, flagging that
  the delivery date in bullet two was left as `[date]` because it was not supplied
- Rewrite an assistant-drafted LinkedIn post that tests as generic, cutting the
  tricolon and the summary close the profile says the user never writes
