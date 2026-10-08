---
name: write-term
description: Records a project term in the CONTEXT.md at the project root as one line with its meaning, adding words to avoid only when another word for it actually came up, after Daniel confirms the exact line. Use when a word with one fixed meaning in this project comes up or settles that CONTEXT.md does not define yet, such as during an interview, a triage or an architecture review, when Daniel answers a question about a term's meaning or its line, or when a skill hands over terms to record, such as a Spec's terms.
---

`CONTEXT.md` is the glossary every other skill reads. A term that settles in a conversation and is not written down drifts; a term written without Daniel's confirmation, or with guessed synonyms, puts words into the project he never chose.

Run it in the main conversation: only there can Daniel confirm.

## 1. Read CONTEXT.md

Read the `CONTEXT.md` at the project root, and only there: a project has one. When it does not exist, record nothing and say: "No CONTEXT.md at the project root. Run write-agent-docs first." Creating the file here would skip the template `write-agent-docs` generates.

**Done when** the root `CONTEXT.md` is read, or the run has stopped with that sentence.

## 2. Term or plain word

For each word handed over or settled in the conversation, take its candidate meaning, the other words that came up for the same thing in the conversation, a Spec or the code, and where it came up.

Check presence first, so a recorded term never gets a second line:

- **Already recorded:** a line of `CONTEXT.md` starts with `**<term>**:`, compared case-insensitively. Record nothing; quote the existing line.
- **Term:** a word handed over from a Spec's `## Terms` line is a term with that line's meaning, because the Spec already settled it. A word from a conversation is a term when it has one fixed meaning in this project, narrower than or different from its everyday sense, so reading it the everyday way would mislead. Go on with step 3.
- **Plain word:** a word from a conversation that means what it means anywhere, or that Daniel says means nothing more specific. Record nothing and ask nothing; say in one line that it stays a plain word. A glossary of everyday words hides the terms that matter.

**Done when** every word is a term, a plain word or already recorded.

## 3. Build the line

One line per term: `**<Term>**: <meaning>.`

- The term is the word Daniel uses for the thing. When two words came up and Daniel chose one, that one is the term; when he has not chosen, show the line with the word he used last and leave the choice to his answer.
- The meaning is one sentence in Daniel's words where he gave them, adding no fact he did not state.
- Words to avoid follow on the same line, `**<Term>**: <meaning>. _Avoid_: x, y.`, only for other words that actually came up for the same thing. A word you think of yourself is a guess, and a guessed list is noise. With no other word, the line ends after the meaning.

Example: Daniel first said "bill", then chose "invoice":

```
**Invoice**: a numbered request for payment sent to one customer for delivered work; once sent it is never changed, only cancelled by a credit note. _Avoid_: bill.
```

**Done when** each term has exactly one line in this shape.

## 4. Confirm the line

Only a yes to a question that showed exactly this line records it. When a question in the conversation already showed a line for this term, the line of the last question in the conversation that showed a line for this term is the line to confirm and to append, unchanged, even where step 3 would word it differently: it is the latest line Daniel saw, and rebuilding it would ask him again for words he already answered. Check the conversation for Daniel's answer to that question:

- **Yes to the line:** go on with step 5.
- **No question showed this line yet**, including when Daniel only confirmed the meaning or a calling skill confirmed something else: he has not seen the exact words, the words to avoid included. Ask and end the turn:

  ```
  Append this line to CONTEXT.md?

  <line>
  ```

  Several terms settled together go into one question with one line each; Daniel may strike lines, and only the lines he keeps count.
- **Anything else**, a no, a correction, another topic or no answer: record nothing. After a correction, build the line again from his words and ask again.

**Done when** each line has Daniel's yes, or the turn ends on the question, or nothing is recorded.

## 5. Append

Append each confirmed line at the end of `CONTEXT.md`, after the last term, with one blank line before it, and keep exactly one newline at the end of the file. Leave every existing line as it is: the terms are Daniel's project section, and only he rewords or reorders them.

**Done when** the file is its old content, a blank line and the new line per term, ending with one newline.

## 6. Report

Name the recorded lines and say that `CONTEXT.md` is changed and not committed. Committing is left to the project's change flow, like every other file a house skill writes.

**Done when** the report names every recorded line, or says that nothing was recorded and why.
