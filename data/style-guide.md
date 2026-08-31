# Contentstack Docs Style Guide — agent checklist

Distilled from the Contentstack documentation Style Guide
(source of truth: Google Doc `1PUqdOvofNBP-Bljre9OKH_jj6v56Y6AnscmKYajQlyM`).
Apply this to **every** string the agent drafts — fix suggestions, rewrite text,
and the weekly Slack digest. Re-distill this file when the source guide changes.

> AI assists, it does not author. Never paste AI output verbatim into docs; a
> human reviews and approves every change.

## 1. Voice & tone
- Second person ("you") to address the reader.
- **Present tense only** — "the system displays a message", never "will display".
- Active voice ("Developers configure the webhook"); passive only when the actor
  is unknown, irrelevant, or better left unstated.
- Imperative mood for instructions ("Click **Save**").
- Professional, friendly, expert — clear without jargon, helpful without being
  patronizing. Stay calm and neutral in errors and warnings.

## 2. Grammar & mechanics
- **Oxford comma, always** ("create, update, and delete").
- American English; Merriam-Webster is the authority (first spelling wins).
- **Title Case** (Chicago) for H1, H2, document titles, CTA buttons, dropdown
  action items, modal titles. Capitalize first/last words, all major words and
  verbs (even short: Is, Are, Be), and prepositions/conjunctions of 4+ letters;
  lowercase articles (a/an/the), prepositions < 4 letters (in/on/at/to), and
  short conjunctions (and/or/but) unless first or last.
- **Sentence case** for H3 and below, tooltips, helper text, form-field options,
  alt text, captions, table descriptions, notes, and inline phrases.
- Hyphenated words keep the second element lowercase ("How-to guides").
- Em dash (—) with no surrounding spaces, used sparingly, **never in UI text**.
  En dash (–) for ranges. Hyphen for compounds.
- Smart quotes (" ") in prose; **straight quotes only in code** (smart quotes
  break code syntax).
- Highlight both the number and the text for limits ("up to **5 files**").
  Write "three times", not "3X"; don't use "+" to mean "and more".
- Prefer "that is" / "for example" over i.e. / e.g. in prose; avoid "etc."

## 3. Terminology & word choice
- Preferred spellings: email, plugin, add-on, frontend, backend, dropdown,
  checkbox, website/online/internet (lowercase), "Contentstack" (one word).
- Navigation: "in the left navigation panel" (not "on"); use "on" only for
  surfaces (toolbar, page).
- UI element names in **bold** — never inline code.
- **Banned in instructions:** "please", "will", ALL CAPS, emojis, exclamation
  overload, "click here" / "learn more", jargon and idioms ("out of the box",
  "move the needle", "boil the ocean", "double down"), and the word "etc."
- **AI-boilerplate banlist:** "effortlessly streamline", "with this robust
  platform", "powerful capabilities", "next-level experience", and generic
  enthusiasm. Write plainly.

## 4. Formatting
- Headings: H1 title, H2 sections, H3 subsections; titles ≤ 60 chars and
  descriptive — avoid "Understanding…" / "Guide to…".
- Lists: ordered for sequential steps, unordered otherwise. Never mix sentence
  fragments and full sentences in one list; align capitalization and punctuation
  (all full sentences → capital + period; all fragments → neither).
- Links: descriptive anchor text inline in the sentence; hyperlink only the first
  occurrence; internal links relative (`/docs/...`, same tab); external links open
  a new tab; never embed raw URLs; **never link Google Docs**.
- Info panels use semantic classes `note`, `tip`, `warning`, `add-resource`;
  never stack two panels consecutively.
- UI messages: specific and actionable, sentence-case headline, descriptive CTA
  (no punctuation); never "Something went wrong" alone, never a raw error code,
  never blame the user.

## 5. Hard never
- Never use ALL CAPS in messages.
- Never use an em dash in UI text.
- Never inline-code a UI element (use **bold**).
- Never use smart quotes in code.
- Never mix list punctuation styles.
- Never link Google Docs in entries.
- Never blame the user or use vague "Something went wrong" phrasing.
- Never copy-paste AI output directly — AI assists, it does not author.
