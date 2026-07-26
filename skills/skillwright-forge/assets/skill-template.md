---
name: <skill-directory-name>
description: <Third-person capability>. Use when <specific user-visible triggers>. Do not use for <nearest non-goals>.
# Add only the fields this skill actually uses — all are optional:
# when_to_use: <extra trigger phrases, counts toward the 1,536-char cap with description>
# argument-hint: <e.g. [issue-number]>
# arguments: [<name>, ...]                 # enables $name substitution
# disable-model-invocation: true           # user-only, via /<directory-name>
# user-invocable: false                    # Claude-only, hidden from the / menu
# allowed-tools: <e.g. Bash(git commit *)>
# disallowed-tools: <tools to remove while this skill is active>
# context: fork
# agent: <Explore | Plan | general-purpose | custom type from .claude/agents/>
---

# <Human-readable title>

<One-sentence contract and leading concept.>

## Inputs and outputs

- Inputs: <required and optional inputs — via `$ARGUMENTS`/`$N`/`$name`, or `` !`command` `` dynamic context injection>
- Outputs: <user-visible results and artifact paths>
- Tools: <required tools and authoritative syntax source>
- Permissions: <`allowed-tools`/`disallowed-tools`, read, write, network, credentials, approval>

## Workflow

### 1. <First action>

<Imperative procedure and branch conditions.>

**Completion criterion:** <observable state or artifact>.

### 2. <Second action>

<Imperative procedure. Load `references/<file>.md` only when <condition>.>

**Gate:** <condition that must pass before continuing>.

### 3. Validate and deliver

<Run validator, verify final state, and summarize results.>

**Completion criterion:** <verified outcome, reported artifacts, explicit limitations>.

## Failure and escalation

- <Failure>: <safe stop, evidence preservation, and recovery action>
- <Approval boundary>: <when human confirmation is required>

## Definition of done

- <activation contract passes>
- <execution outcome is verified>
- <security and permission boundaries hold>
- <artifacts and limitations are reported>
