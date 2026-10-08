---
name: write-tests
description: Writes tests first at agreed seams, one failing test and the minimal code to pass it at a time, asserting observable behaviour against independent expected values and mocking only at system boundaries. Use when behaviour is built or a bug is fixed test-first, when Gherkin scenarios become automated tests, or when a test is about to reach into internals.
---

A test is worth keeping when it fails for wrong behaviour and survives a rewrite of the code underneath. Tests against internals break on every refactor and pass while the behaviour is wrong, so they cement drift instead of catching it.

## 1. Pick the seam

A seam is the public boundary where behaviour can be observed without reaching inside: a module's exported interface, an HTTP endpoint, a command, a UI action. Take the seams from the ticket's implementation notes. When none is agreed for a behaviour, ask the caller instead of choosing one; a test at the wrong seam locks in the internals it touches.

Use the terms of the Spec and `CONTEXT.md` for test names and setup.

**Done when** every behaviour to build has a named seam.

## 2. Red

Write one test for one behaviour:

- Its name states the behaviour in domain terms. For a Gherkin scenario, the name is the scenario name verbatim, so review and integration tests can match it.
- Setup and action go through the seam's public interface only.
- The assertion checks the observable outcome against an independent expected value: a literal, a worked example, the Spec. An expected value computed the way the code computes it passes by construction.

Run it. It must fail on the missing behaviour or the missing interface, not on broken setup.

**Done when** exactly one new test fails for the right reason.

## 3. Green

Write the least code that makes this test pass. Code for the next test waits for the next test; anticipated code is untested code.

Run the test file: the new test passes and every earlier test still does.

**Done when** all tests in the file pass and no code exists that no test needed.

## 4. Repeat

Take the next behaviour and go back to step 2. Let each cycle inform the next test. A batch of tests written up front tests the imagined shape of the code, not its behaviour.

**Done when** every behaviour has passed through red and green.

## Mocks

Replace only boundaries the project does not own: external services, the clock, randomness, and the network or file system when a real one is impractical. Prefer the project's real database or a test instance when it has one. Never mock the project's own modules; a mocked collaborator hides exactly the integration the test should prove.

Pass boundary dependencies in from outside, so a test can substitute them without patching internals.

## Traps

A test is wrong when it:

- asserts calls, call counts or call order of internal collaborators,
- verifies through a side channel, such as reading the database instead of using the interface,
- tests private functions directly,
- breaks when the code is refactored without a behaviour change,
- accepts a snapshot nobody read.
