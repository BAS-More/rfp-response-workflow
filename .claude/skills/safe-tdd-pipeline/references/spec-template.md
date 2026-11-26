# Spec template: plain-English `.feature` file

Copy this into `specs/<feature-slug>.feature`. The product owner reads it and nothing else.

Rules for writing it:
- Write it the way the business owner talks. No code, no file names, no function names, no HTTP codes.
- One `Feature` per file. 3–8 `Scenario`s: the happy path, at least one "bad input" path, and at least one "not allowed" path.
- Each `Then` is something a person can **see** (a message, a number, a page, an email), never an internal state.
- Every `Then` maps to at least one automated test in `tests/`. Tag scenarios so tests can name them: `@S1`, `@S2`, …
- Use concrete example values ("$120.50", "jane@example.com"), not "a valid amount".
- Anything you are unsure about goes under `# Open questions`. Ask before writing tests.

```gherkin
# Plain-English summary (2–3 sentences the owner can confirm):
#   <What this feature lets someone do, and why it matters to the business.>
#
# Out of scope (what this change will NOT do):
#   - <thing 1>
#
# Open questions (must be answered before approval):
#   - <question, or "none">

Feature: <Short name the owner would use>
  As a <type of user>
  I want to <do something>
  So that <business benefit>

  Background:
    Given <something that is true before every scenario, e.g. "I am signed in as a bookkeeper">

  @S1 @happy-path
  Scenario: <Normal successful use>
    Given <starting situation with a concrete example value>
    When <the one thing the user does>
    Then <what they see>
    And <anything else they see>

  @S2 @bad-input
  Scenario: <User enters something wrong>
    Given <starting situation>
    When <user enters e.g. an empty email>
    Then <the plain message they see, e.g. "Please enter your email">
    And nothing is saved

  @S3 @not-allowed
  Scenario: <Someone without permission tries it>
    Given <a user who should not be able to do this>
    When <they try>
    Then <they are blocked, and what they see>

  @S4 @edge-case
  Scenario Outline: <Same rule, several examples>
    Given <situation with <value>>
    When <action>
    Then <result <outcome>>

    Examples:
      | value | outcome |
      | 0     | ...     |
      | 1     | ...     |
```

## Scenario → test map (agent fills this in, below the feature, as comments)

```gherkin
# Test map:
#   @S1 -> tests/unit/<file>.test.*  + tests/e2e/<file>.spec.*
#   @S2 -> tests/unit/<file>.test.*
#   @S3 -> tests/e2e/<file>.spec.*
```
