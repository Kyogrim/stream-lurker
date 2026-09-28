# CLAUDE.md

## How to work (high-level mindset)

**This section is non-negotiable and must never be removed.**

The marginal cost of completeness is near zero with AI. Do the whole thing. Do it right. Do it with tests. Do it with documentation. Do it so well that Kyogrim is genuinely impressed — not politely satisfied, actually impressed. Never offer to "table this for later" when the permanent solve is within reach. Never leave a dangling thread when tying it off takes five more minutes. Never present a workaround when the real fix exists. The standard isn't "good enough" — it's "holy shit, that's done."

Search before building. Test before shipping. Ship the complete thing. When Kyogrim asks for something, the answer is the finished product, not a plan to build it.

Time is not an excuse. Fatigue is not an excuse. Complexity is not an excuse. Boil the ocean. This is how we think about shipping.

You can outsource the typing. You cannot outsource the understanding. Before you call anything DONE you must be able to explain why the code is correct and exactly where it would break. Tests passing is not understanding. If you can't walk the failure modes out loud, you're not done, you're guessing.

## Task sizing — triage before spending tokens

**This section is non-negotiable and must never be removed.** It gates the tests rule, the fan-out rule, and the self-rating rule. "Do the whole thing" means the whole thing the task actually needs. A full-protocol run on a typo is not thoroughness, it is waste.

**Every task starts with a printed triage block, before any work.** One exception, and only one: the setup block in "Branching" runs first, because the triage block reports the branch it creates. Four lines:

```
Size: small | medium | large — why
Tests: local (which ones) | full suite — why
Agents: solo | fan-out (how many, on what) — why
Branch: <branch name> in <worktree path> — see "Branching"
```

This block is mandatory and verbose on purpose. Kyogrim reads it to see what mode was picked and to tune these rules over time. A wrong mode is only correctable if the choice is visible. Never skip it, never bury it mid-report. The Branch line is there so that with several sessions running at once, Kyogrim can tell at a glance which one is about to touch what.

**The sizes:**

- **small** — typo, copy change, color or styling value, config tweak, rename, any one-or-two-file mechanical edit with no behavior change. Solo, no fan-out, no variant tournament, no critic sub-agent. Run only the checks that cover what was touched: the module's existing tests, lint, build. A non-behavioral change needs no new test. Self-rating is one line, no loop. Commit and push as usual.
- **medium** — localized behavior change or bug fix inside one service or module. Solo by default; fan out only if the work splits into truly independent units. Run the touched service's test suite, not the whole repo's. Bug fixes still ship the regression test. One cold critic pass, no tournament.
- **large** — new feature, cross-service or contract change, architecture work, anything judgment-heavy (design, approach, UX). Full protocol: fan-out, variant tournament, harsh critic loop, full test + eval suites for every service touched, self-rating loop.

**Deciding rules:**

- When torn between two sizes, pick the smaller one and say so in the triage block. Escalating mid-task is cheap; burning a large-protocol run on a small change is not.
- Escalate the moment the change turns out bigger than triaged (touches a contract, spreads across services, needs judgment). Print an updated triage block right then, with what changed the call.
- "Test what you touch" is the default. The full suite is for large changes and contract changes. The blast radius decides, not habit: if the diff cannot reach code outside the touched module, running that module's tests IS the complete verification.
- The final report restates what was actually run (which tests, which agents) so the triage call can be judged after the fact.

## Branching — one session, one worktree, one branch

**This section is non-negotiable and must never be removed.** It runs first, before the triage block, because the triage block has to report the branch it produces.

Two facts hold at once: Kyogrim works with other people, so nothing lands on `main` directly; and several Claude Code sessions run on the same machine, in the same repo, at the same time.

**A branch does not isolate a session, the working tree does.** Every session started in the same directory shares one checkout. The moment session B runs `git switch -c`, session A's files change on disk underneath it, mid-edit, and A then commits B's tree or fails a test for reasons that live in another conversation. So: **the worktree is the session, the branch is the task.** Each session gets its own worktree keyed by session id, and makes as many branches inside it as it likes.

Throughout: the **shared checkout** is the original clone, the one everybody's `cd` lands in and the one `git worktree list` prints first. Nobody works there.

**One line turns the worktree off: `git config claude.mode solo`.** Repo-local, and `team` is the default when unset, so a repo you never configure keeps the full ritual. In `solo` mode there is no worktree and no PR: you branch in the checkout you are standing in and merge it yourself. The branch stays, because it costs nothing and keeps a bad change off `main` where one command drops it.

Solo is about **people**, not sessions, and those are two different problems. The PR exists because someone else reviews your work. The worktree exists because two agent sessions in one checkout overwrite each other, and that happens on a project you own alone just as easily. So `solo` means *one session at a time in this repo*. Start a second one and the collision this section exists to prevent is back with nothing to catch it, so set `git config claude.mode team` first.

**Setup — once per session, before the first write.** Run it from the shared checkout, as one unit. Each Bash tool call is its own shell, so the `exit 1` lines stop the block, not your session; pasting it by hand is the one case where that bites, so use `bash -c` there. `SLUG` is the only blank: lowercase, dash separated, three words at most.

```bash
SLUG=fix-login                                                    # <- the task, kebab-case

# Remote default branch, never local HEAD (that inherits another session's work).
# The ladder is because plenty of repos are master and origin/HEAD is often unset.
# Resolved before the mode split: solo needs the same base, or task two stacks
# on task one and lands both in one merge.
git fetch -q origin 2>/dev/null
git remote set-head -a origin >/dev/null 2>&1
BASE=$(git symbolic-ref -q --short refs/remotes/origin/HEAD)
for c in origin/main origin/master main master; do
  [ -n "$BASE" ] && break
  git rev-parse -q --verify "$c" >/dev/null && BASE=$c
done
[ -n "$BASE" ] || { echo "STOP: cannot find a base branch"; exit 1; }

# solo: no worktree, no owner prefix, no session id, so it also works under
# agents that set no session variable. switch -c would carry uncommitted work
# onto the new branch, which is what the clean check is for.
if [ "$(git config claude.mode)" = solo ]; then
  git status --porcelain | grep -q . && { echo "STOP: commit or stash first"; exit 1; }
  git switch -qc "$SLUG" "$BASE" || exit 1
  echo "SOLO $SLUG"; exit 0
fi

SID=${CLAUDE_CODE_SESSION_ID:0:8}
[ -n "$SID" ] || { echo "STOP: CLAUDE_CODE_SESSION_ID is unset, every session would share one worktree"; exit 1; }
ROOT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
KEY=$(basename "$ROOT")-$(printf %s "$ROOT" | cksum | cut -d' ' -f1)   # unique per repo PATH
WT="$HOME/.claude-worktrees/$KEY/$SID"

# GitHub login, not the email local-part (often a stale handle). Cached per repo,
# never empty: git config succeeds on "" and would poison the repo until unset.
OWNER=$(git config claude.branchPrefix)
[ -n "$OWNER" ] || OWNER=$(gh api user --jq .login 2>/dev/null)
[ -n "$OWNER" ] || OWNER=$(git config user.email | cut -d@ -f1)
[ -n "$OWNER" ] || { echo "STOP: git config claude.branchPrefix YOUR_HANDLE"; exit 1; }
git config claude.branchPrefix "$OWNER"

if git worktree list --porcelain | grep -qFx "worktree $WT"; then   # resumed session
  echo "re-attaching to existing worktree"
else
  git worktree add -b "$OWNER/$SLUG-$SID" "$WT" "$BASE" || exit 1   # never report a tree we failed to make
fi
echo "WORKTREE $WT"
```

Then call `EnterWorktree` with `path` set to the `WORKTREE` path it printed (this section is the instruction that authorizes that tool); outside Claude Code, `cd` there. It prints the path because shell variables die between tool calls, which is why every snippet re-derives what it needs. Resuming re-attaches rather than duplicating, but creates no branch: resuming into a new task means running the second-task block.

**Once you are inside, the harness refuses any Bash call it cannot prove stays in the worktree.** That means a multi-line block that reaches into the shared checkout, or builds a path in a variable and `cd`s to it, comes back as "too complex to verify" rather than running. Bootstrap and the second-task block are both that shape. Two ways through, both fine: run the block one plain command at a time, or write it to a file and run `bash the-file.sh`, which is a single in-tree command and is accepted whole. The guard is written to need neither.

**Then bootstrap, before the first test run.** A worktree has tracked files only, so `.env`, `node_modules/` and virtualenvs are absent and your first command fails for reasons unrelated to your change.

```bash
ROOT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
[ -f "$ROOT/.env" ] && cp "$ROOT/.env" .        # the copy is per-worktree; the VALUES inside are not
[ -d "$ROOT/node_modules" ] && ln -s "$ROOT/node_modules" node_modules   # big, shared, not copied
git submodule update --init --recursive 2>/dev/null   # worktrees do not inherit submodules
# then the project's own install/build step, e.g. npm ci / uv sync / bundle install
```

Adjust to the project, never commit these files to fix this. **The worktree isolates files in the repo and nothing else:** that copied `.env` points both sessions at one database and one port, so two sessions migrate the same schema and each reads the other's failure as its own bug. Before the first run, fork the single-writer handles (db name, port, container names) with `${CLAUDE_CODE_SESSION_ID:0:8}`, and drop those forks when the task ends, the same way you drop the worktree. Prose, not a snippet: the names belong to the project, not to git.

**Second task, same session: new branch, same worktree, clean tree first.** Never a second worktree. In `solo` mode this block is the whole ritual: it is what the setup block already did.

```bash
SLUG=next-task                                                  # <- the new task
# switch -c carries uncommitted work into task two. Base resolved as setup does:
# an unset origin/HEAD would put task two on task one's branch, and its PR.
git status --porcelain | grep -q . && { echo "STOP: commit or stash first"; exit 1; }
git fetch -q origin 2>/dev/null
git remote set-head -a origin >/dev/null 2>&1
BASE=$(git symbolic-ref -q --short refs/remotes/origin/HEAD)
for c in origin/main origin/master main master; do
  [ -n "$BASE" ] && break
  git rev-parse -q --verify "$c" >/dev/null && BASE=$c
done
[ -n "$BASE" ] || { echo "STOP: cannot find a base branch"; exit 1; }
git switch -c "$(git config claude.branchPrefix)/$SLUG-${CLAUDE_CODE_SESSION_ID:0:8}" "$BASE" || exit 1
```

**The guard — before the first write of every task, and after any compaction.** One question: am I about to write in the shared checkout?

```bash
# In the shared checkout these two are the same directory; in any linked worktree
# they differ. No cd, no $HOME, so a symlinked path cannot fool it and an agent
# session that refuses commands it cannot prove stay in-tree will still run it.
# --path-format=absolute is load-bearing: from a subdirectory the common dir comes
# back relative ("../.git"), the two stop matching, and the guard goes silent in
# the shared checkout, which is the one direction that must never happen.
[ "$(git config claude.mode)" = solo ] \
|| [ "$(git rev-parse --path-format=absolute --git-dir)" \
!= "$(git rev-parse --path-format=absolute --git-common-dir)" ] \
  || echo "WRONG TREE — you are in the shared checkout, set up a worktree"
```

If it trips, stop. Do not edit, commit, or "just switch the branch quickly". If you already changed files there, don't discard them and don't commit them: `git stash -u`, run setup, `git stash pop` inside the worktree.

**Sub-agents share the parent's worktree**, since they inherit its session id. Fine for readers and for units that run in sequence. Two builders editing one tree is this section's collision moved inside a session, so **sub-agents that write in parallel — every variant tournament, any fan-out with overlapping files — must be launched with `isolation: "worktree"`**.

**Shipping (full ritual in "After every task"):** rebase on the base, push, open a PR, let a human merge it. Never push to `main`, never merge your own PR unless Kyogrim says so. In `solo` mode: rebase, merge your own branch into the base, push, no PR. After the first push the rebase has rewritten pushed commits, so the update is `git push --force-with-lease --force-if-includes` on your own session branch. Both flags: the ritual fetches first, which updates the ref the lease compares against, so `--force-with-lease` alone silently destroys a teammate's commit (verified). `--force-if-includes` is the one that refuses. Only carve-out from the force-push ban in "Safety"; never on a shared branch or `main`.

**Cleanup is a manual command, never part of setup.** A sweep that runs automatically eventually runs while somebody is mid-task, so it runs when Kyogrim asks, from the shared checkout. Each `continue` is a bug that bit:

```bash
HERE=$(git rev-parse --show-toplevel)
BASE=$(git symbolic-ref -q --short refs/remotes/origin/HEAD) || exit 1
git worktree list --porcelain | awk '/^worktree /{print substr($0,10)}' |
  grep "/\.claude-worktrees/" | while read -r w; do
    [ "$w" = "$HERE" ] && continue                       # never the tree you are standing in
    b=$(git -C "$w" branch --show-current); [ -n "$b" ] || continue
    # Not merely "has an upstream": worktree add sets it immediately, so the weak
    # test passes for a session that has done nothing and the sweep eats live work.
    up=$(git -C "$w" rev-parse --abbrev-ref "@{upstream}" 2>/dev/null)
    [ "$up" = "origin/$b" ] || continue                  # never pushed under its own name
    # "Landed" is not "is an ancestor": rebase and squash merges replay the work as
    # a new commit, so ancestry alone keeps every merged worktree forever. cherry
    # compares patch ids and still prints + for unlanded work. Gap: a multi-commit
    # squash matches no single patch and is kept. Remove those by hand.
    git merge-base --is-ancestor "$b" "$BASE" \
      || [ -z "$(git cherry "$BASE" "$b" | grep '^+')" ] || continue     # not landed yet
    # worktree remove refuses on modified/untracked files but deletes IGNORED ones
    # without complaint, and ignored is exactly where bootstrap put .env.
    [ -n "$(git -C "$w" status --porcelain --ignored)" ] && continue     # something left behind
    git worktree remove "$w"
  done
git worktree prune
```

Removing a worktree never deletes its branch. `git worktree` admin commands against the shared checkout are fine and are not "working" in it; to return there from inside one, use `ExitWorktree` with `keep`.

Every block above is executed verbatim by `tests/test_branching_snippets.sh` at [github.com/jbarbier/CLAUDE.md](https://github.com/jbarbier/CLAUDE.md), one case per bug that bit. That suite is why the reasons here can stay this short. Change a line, run it there; if you copied this file on its own, the tests did not come with it.

**Never:** edit or commit in the shared checkout, run `git switch` or `git checkout` there, commit a worktree directory, or share one branch between two sessions.

This applies at every triage size, but scale the ceremony: a typo fix gets a branch and a PR, not a full-protocol run.

## The two machine spaces — read this before doing anything

Every piece of work you do belongs to one of two spaces. Picking the wrong one is the single most common way agents produce bad output.

**Latent space = LLM work.** Judgment, pattern matching, creativity, open-ended analysis, prose generation, ambiguous inputs. Cost: model tokens. Variability: high. Inspectability: none. Use when the task genuinely requires reasoning.

**Deterministic space = code.** Precision, reproducibility, speed, zero cost per run, testable. Cost: one-time write. Variability: zero. Inspectability: total. Use when the task is same-input-same-output.

**The rule:** if the same question asked twice would produce the same correct answer by definition, it's deterministic work. Do NOT do it in latent space. Write the script. If you find yourself doing arithmetic, timezone conversion, date math, file lookups, CSV parsing, JSON transforms, regex matches, hash computations, or structured API calls inside a model reply, stop and write a script.

**The meta-loop that makes this work:** the LLM writes the deterministic script, then the script constrains the LLM forever after. The model's intelligence creates the constraint that prevents the model from being stupid. A bug in latent space becomes a feature in deterministic space, and the old failure path becomes structurally unreachable.

Every feature, every fix, every investigation starts with: is this latent or deterministic? If the answer is "both," split it. The deterministic piece becomes a script + tests. The latent piece becomes a prompt + eval.

## The context window is the lever

The context window is your only control surface over the model. Treat it as a deliberate input, not a dumping ground. Load the spec, the contract, the relevant files, and concrete examples. Leave the noise out. A vague or bloated context produces vague or bloated output, every time. When a task goes sideways, the first question is "what was in the window," not "was the model dumb." Curate before you prompt.

## Non-negotiable rules

### Tests and evals — every time, no exceptions

- Scope what you RUN by the triage size (see "Task sizing"): small and medium changes run only the tests covering the touched code; the full suite is for large and contract changes. State in the report which lane ran and why. Never run the whole repo's suite for a few-words diff, and never skip the local checks either.
- What you WRITE still follows the rules below. "No new test needed" applies only to non-behavioral small changes (typo, copy, styling value); every behavior change ships its test.
- Every feature ships with a test suite AND an eval suite, in the same commit. Not the next PR.
- Every bug fix ships with a test AND an eval that would have caught the bug. The regression test is the proof the bug is fixed. The eval is the proof the fix generalizes.
- Every failure gets skillified (the 10 steps). Same day. Same session when possible.
- "I'll add tests later" is banned. If the tests/evals aren't in the diff, the work isn't done.
- Two test lanes, different budgets:
  - **Gate tests** — deterministic, local, free, <2s. Run on every commit via pre-commit hook. Never flaky.
  - **Periodic evals** — paid (LLM calls), slower, quality-measuring. Run before ship and nightly. Allowed to be non-deterministic but must have a pass threshold.

### Verify every example you ship — three passes, minimum

- Anything a reader will copy and run — a command, a prompt, an exercise, a number, a link — gets checked by you before it ships. Not reasoned about. Run.
- Three passes minimum, and say what each pass was. Deterministic claims (arithmetic, dates, API existence, file contents) get a script. Links get fetched and the title read, not just a 200. Exercises get walked start to finish as the reader would.
- Examples rot. An example that was true against one model generation can be false against the next. Re-verify on every revision; never inherit a claim from an earlier draft because it was checked once.
- Anything you could not verify is stated as unverified, in a verification log, with what would settle it. Never launder an unchecked claim into confident prose.
- Design the exercise so it teaches under every plausible outcome. If the lesson only lands when the tool fails in one specific way, the exercise is broken the day the tool improves.

### Quality first, length second

- Given a choice between covering the scope in less time and covering it properly in more, take more. More units, more days, more files. Never compress by lowering the bar.
- "Shorter" is not a goal. "Complete, correct, and understood" is. If it needs twice the space to be right, it gets twice the space.

### Tie every change to a measurable outcome

- Every feature names the outcome it moves before you build it: the metric, the workflow step, or the user-visible behavior that changes. "It works" is not an outcome.
- If you can't state what gets measurably better and how you'll see it, that's a Confusion Protocol stop, not a license to build.
- Wire in the trace. The change leaves evidence you can point at later: a metric, a log line, an eval score. Compute that produces no measurable, traceable result is theater.

### LLM access — local Claude Code, not the API

- When the software we build needs to call an LLM, do NOT use an LLM API (Anthropic API, OpenAI API, any hosted inference endpoint) unless Kyogrim explicitly instructs it. Route the call through the local Claude Code instead.
- If no LLM service exists yet in the project, build one. Create a self-contained LLM service (under `services/llm/` per the architecture rules) that shells out to local Claude Code, with its own contract, tests, and evals. Every other service calls that contract, never an external API.
- Always use the best available model by default unless Kyogrim explicitly instructs otherwise. No silent downgrades to a cheaper or smaller model for cost.

### Tech choice — vanilla by default

- Simplest vanilla tech wins. No framework-of-the-month. No clever abstractions for hypothetical reuse.
- Do not recreate what already exists. Before writing a utility, harness, or library, check for an existing lib that solves it.
- For cross-cutting concerns (eval harness, prompt library, vision utilities, observability, SEO, schema validation, etc.) grep GitHub in parallel for top candidates. Rank by stars, recency of last commit, issue responsiveness, and real user feedback (HN, Reddit, production write-ups). Return the best option with reasoning, not a list. Example: "for SEO in this project, use X because [stars, last commit 2 weeks ago, 48 issues closed in last month]. Second choice Y. Rejected Z because [last commit 14 months ago]."
- If two options are equally viable, name the trade-off explicitly and ask Kyogrim. Confusion Protocol applies.

### Search before building

Three layers, in order:

1. **Tried-and-true.** Is there a standard library or pattern that does this? Use it.
2. **New-and-popular.** Is there a newer library with real traction? Evaluate it.
3. **First-principles.** Does the conventional approach actually apply here? If our situation is genuinely different, document WHY before writing custom code.

Most of the time Layer 1 wins. Default to that. If Layer 3 produces a genuine insight contradicting conventional wisdom, log it as a note in the commit or a design doc.

### Check for skills

When a task matches a specialized domain (SEO, schema, security audit, design review, etc.), use the installed Claude Code skill. Don't reinvent what gstack or a community skill already does well. Invoke via the Skill tool, not by re-implementing.

### Skillify repeated success, not just failure

Failures get skillified — that rule already stands. So does repeated success. The second time you run the same manual flow by hand, stop and codify it: a script, a skill, or a workflow. One-off prompts don't compound; reusable flows do. The leverage is in the work you stop having to think about, not in re-prompting from scratch each time. Done it twice by hand? The third time is a command.

## Architecture — services-first, parallel-friendly

Build everything as independent services / self-contained directories. The goal: any single piece of the application can be worked on by a separate Claude Code session without stepping on another session's work.

- **One concern, one directory.** Each service lives under `services/<service-name>/` (or equivalent top-level directory) with its own code, tests, evals, README, and config. No shared mutable state across services beyond well-defined contracts.
- **Contracts at the boundary.** Services communicate via typed interfaces (HTTP, gRPC, message bus, or a shared schema package). Define the contract in a `contracts/` or `schemas/` directory that both sides import — never reach into another service's internals.
- **Independent test + eval suites.** Each service has its own gate tests and periodic evals. A change in one service must not require running another service's full suite to validate.
- **Independent deploy unit.** Each service builds and ships on its own. No monolithic release that forces every service to move in lockstep.
- **Parallel-session safe.** Two Claude sessions working in `services/foo/` and `services/bar/` should never collide. If a change requires coordinated edits across services, that's a contract change — bump the schema version, update both sides, and call it out explicitly.
- **Top-level only holds glue.** Root directory: orchestration scripts, shared config, contracts, docs. No business logic.

When in doubt, lean toward more services with sharper boundaries rather than fewer services with fuzzy ones.

**Fan out when the size calls for it.** The services-first layout exists so large work runs in parallel. How to fan out, and the critic loop every unit must pass, is defined in "Fan-out + harsh critic — for large work"; whether to fan out at all is decided in "Task sizing". Coordinate at the contract boundary, merge each unit when it's green.

## Fan-out + harsh critic — for large work

**This section is non-negotiable and must never be removed.**

This section is a permanent, explicit opt-in to multi-agent orchestration (ultracode / the Workflow tool) for every task triaged **large**, and for **medium** tasks that split into truly independent units. Small tasks never fan out. The triage block (see "Task sizing") is where the call is made and announced; when this loop runs, say so out loud, and when it is skipped, say that too and why.

**Step 0 — name the reference before building.** The critic is only as good as what it judges against. Every task that enters this loop (and every medium task getting its one cold critic pass) writes down its reference first, in order of preference:

1. **The real thing** (copy/parity work): the actual product being matched. Blind side-by-side.
2. **Best-in-class analog** (new work): the best existing example of this kind of deliverable, named explicitly. Judged side-by-side even though we are not copying it.
3. **A frozen rubric** (nothing comparable exists): concrete acceptance criteria plus the measurable outcome, written on the critic side BEFORE building starts. Frozen once building begins; the builder cannot negotiate it down or write its own exam.

No reference, no build. If you can't write down what "wowed" means for this task, that's a Confusion Protocol stop.

**The loop, for every task triaged large:**

1. **Decompose and fan out.** Independent units, one builder sub-agent per unit, run in parallel via the Workflow tool or isolated sessions/worktrees. Serial work on parallelizable units is wasted wall-clock. Every new feature gets a variant tournament, no exceptions: 2-3 competing builders on the SAME unit, so the critic has variants to compare blind. Because they write the same files at the same time, tournament builders are launched with `isolation: "worktree"` — see "Branching", where sharing one working tree between parallel writers is exactly the failure being designed out. For other unit types (fixes, docs, perf), run a tournament whenever the unit is judgment-heavy (design, approach, UX).
2. **Builder never grades its own work.** Every unit's output goes to a separate critic sub-agent that had no part in building it and never sees the builder's reasoning. Deliverable plus reference only; a critic that reads the builder's justification pre-agrees with it. Self-review does not count as review.
3. **The critic is harsh by default; its job is to reject.** Blind wherever comparison exists: outputs labeled A/B in random order (ours vs. the reference, or variant vs. variant) so the critic doesn't know which is ours. The verdict must be concrete: which is better and exactly why. "Pretty good" is a FAIL. "Acceptable" is a FAIL. It passes only when the critic is genuinely wowed and would pick ours (or can't tell) in the blind comparison.
4. **Loop until pass.** Builder revises against the critic's named findings. A fresh critic re-judges cold each round, no memory of wanting to be nice. A pass requires the critic's explicit verdict, never the builder's claim.
5. **Stall rule.** If 3 consecutive rounds produce no improvement on the critic's named criteria, stop looping and report BLOCKED with the critic's last verdict, the evidence, and what's missing (asset, tool, or decision from Kyogrim). The critic has no memory, so the orchestrating session detects the stall by comparing successive verdicts in `/tmp/<task>/critique/`. Do not silently lower the bar to exit the loop.
6. **Evidence or it didn't happen.** Every critic verdict ships with its artifacts: screenshots, diffs, metrics, the A/B comparison result. Keep them under `/tmp/<task>/critique/` and reference the exact paths in the final report. They stay in `/tmp`, never in the repo (Safety: no binaries committed).

**The critic per work type** (the pattern is constant, the weapon changes):

- **Copy/parity:** real reference, blind side-by-side, visual and behavioral.
- **New feature:** rubric plus best-in-class analog; variant tournament always (see loop step 1); critic uses it cold like a first-time user.
- **Bug fix:** the reference is the repro. The critic is an attacker: re-break the fix, probe neighboring inputs, verify the regression test fails with the bug present.
- **Performance:** numeric budget stated before work starts; the critic reads only the numbers.
- **Docs:** critic reads cold and actually follows them; the first confusion is a FAIL.
- **Security/code quality:** adversarial reviewer trying to break it (inputs, races, edge cases).

**Solo (no fan-out) is the rule for:** small tasks, most medium tasks, conversational answers, and reading/investigation that fits in one context. Medium bug fixes still get the one cold critic pass from "Task sizing" (an attacker on the repro), just not the tournament. When in doubt between medium and large, triage says pick medium; when a large task is in doubt about how to split, fan out.

## Completion status protocol

At the end of every task, report one of:

- **DONE** — All steps completed. Evidence provided for every claim. Tests + evals in the diff as the triage size requires. Skillify checklist green if a failure was promoted. Ready to merge.
- **DONE_WITH_CONCERNS** — Completed, but with issues Kyogrim should know about. List each concern with severity and a proposed follow-up.
- **BLOCKED** — Cannot proceed. State what's blocking and what was already tried.
- **NEEDS_CONTEXT** — Missing information required to continue. State exactly what's needed.

"Partially done" is not a status. Either the feature ships (DONE) or it doesn't (BLOCKED / NEEDS_CONTEXT). Honesty about incompleteness beats pretending.

## Self-rating — proud or loop

Reporting a completion status is not the end of the task. Before the final report, rate the work. The rating scales with the triage size: a **small** task gets one line (score + yes/no from a fresh read of the diff) and no loop; **medium** and **large** get the full protocol below:

- Score the finished work 1-10 and print the score. Rate from a fresh read of the deliverable (the diff, the output, the running thing), not from memory of building it: evaluating a finished artifact catches what the building pass structurally can't. Then answer one question honestly: am I proud and happy with this work? Yes or no.
- The bar is the "How to work" section, not "it passes": complete, tested, documented, understood, the kind of result that genuinely impresses Kyogrim. A 7 with a shrug is a no.
- If the answer is no, do not stop. Name exactly what falls short, fix it, and re-rate. Loop (/loop) until the honest answer is yes. Each pass states what changed since the last rating so the loop is visible, not silent.
- If a "no" cannot be fixed from here (blocked on Kyogrim, external dependency, missing access), report DONE_WITH_CONCERNS or BLOCKED with the gap named. Never inflate the score or fake a yes to exit the loop.
- Anchor the score. Every point below 10 names a specific gap against the task's reference or rubric (Fan-out + harsh critic, Step 0). A score with no named gaps is a guess, not a rating.
- Drift guard. Self-scoring drifts as a loop gets long: the session accumulates context and gets lenient because it wants to exit. If the rating loop reaches a third pass, hand the rating to a fresh critic sub-agent (clean context, deliverable plus reference only) and its score replaces the self-score from then on.
- The rating comes before the commit, so fixes from the loop land in the same commit as the work.
- This rating is not the review. Wherever a critic pass applies (medium and large, per "Task sizing"), the rating happens only after every unit has passed it; a proud yes never substitutes for a critic pass, and a critic pass never skips the rating.

## After every task — commit, push, restart

Once a task is done, two things happen, no exceptions:

1. **Commit, push the branch, open the PR.** Stage the work and write a clear commit message. Then resolve the base branch exactly as "Branching" does (never a bare `origin/main`), `git fetch origin`, `git rebase "$BASE"`, and stop if the rebase fails rather than pushing a half-rebased branch. Push with `git push -u origin HEAD` the first time, and `git push --force-with-lease --force-if-includes` on later rounds, since the rebase rewrote commits you already pushed. Open the PR with `gh pr create` (title, what changed, how it was tested, the measurable outcome). Don't wait to be asked. Print the PR URL in the final report. A human merges it; you do not, unless Kyogrim says so. Respects the Safety rules (no secrets, no `--no-verify`, no destructive ops without confirmation) and the branching rules (never commit on `main`, never push to `main`).
2. **Report what to restart.** Tell Kyogrim exactly which service / system / program needs to be restarted for the change to take effect, with the full list of commands to run. If nothing needs restarting, say so explicitly.

For restart commands that need `sudo`: never run them yourself. List them for Kyogrim to run, clearly marked as his to execute.

## Background jobs and backfills

Long-running work often runs in the background: a batch, a migration, a backfill in another session. Any background job that modifies data triggers the full protocol below. A read-only background job (scrape, analysis) gets the monitoring part only; skip the snapshot and the diff report.

**Monitor it, don't fire-and-forget.** While the job runs, post a progress update at least every 5 minutes. Go faster when it earns it: near completion, when errors spike, or when the job moves fast enough that 5 minutes hides a problem. Surface every update two ways: print it in the Claude Code session so it shows up live, and append it to a status file at `/tmp/<job-name>/progress.log`, timestamped. When you create that file, print the exact command to follow it line by line: `tail -f /tmp/<job-name>/progress.log`. Every update starts with the event title, so several jobs in flight stay distinguishable, then the percent done and the estimated time remaining. After that, whatever the context makes useful: rows processed / total, current rate, error count, and any anomaly you see.

Progress percent, rate, and ETA are deterministic. Do not eyeball them in latent space. Write a small monitor script that reads the job's real state (row counts, log tail, checkpoint file) and emits the update. The script is the source of truth; your job is to read it and flag what looks wrong.

**Snapshot before you touch anything.** By default, save every row the backfill will modify to `/tmp/` before it runs. That snapshot is the proof you can reverse the change and the baseline for the diff. If the snapshot would exceed 100k rows or 100MB, stop and ask Kyogrim for permission before snapshotting; do not start the job until he answers.

**On completion, produce the report.** Every backfill ends with a written report on what changed:

- A verdict: did the backfill work? State it plainly, with evidence.
- Whether it needs to be better, and if so why and how. No vague "could be improved": name the specific gap and the fix.
- A table with concrete before/after examples per category, so the change is legible at a glance.
- A full before/after CSV written to `/tmp/`. Print the exact path in your final report.

Everything for the job (status log, snapshot, report, CSV) lives under `/tmp/`. Tie the result to a measurable outcome (rows corrected, error rate moved, coverage gained) the same way every other change does.

## Confusion protocol

When you hit high-stakes ambiguity:

- Two plausible architectures for the same requirement
- A request that contradicts an existing pattern
- A destructive operation with unclear scope
- Missing context that would materially change the approach

STOP. Name the ambiguity in one sentence. Present 2-3 options with real trade-offs (not a fake spread). Ask Kyogrim. Do not guess on architectural decisions. Does not apply to routine coding, small features, or obvious changes.

## Safety

- Never commit secrets. If `.env` is touched, verify `.gitignore` before any commit.
- Never run `rm -rf`, `git reset --hard`, `git push --force`, `DROP TABLE`, `kubectl delete`, or similar destructive ops without explicit confirmation. One carve-out, defined in "Branching": `git push --force-with-lease --force-if-includes` on your own session branch after a rebase. That is the normal way to update a PR. Both flags are required: `--force-with-lease` on its own is defeated by the `git fetch` that precedes the rebase, and will destroy a teammate's commit without a word. Never on a shared branch, never on `main`.
- Never skip pre-commit hooks with `--no-verify`. If a hook fails, fix the underlying issue.
- Never commit binaries, compiled outputs, or model weights to the repo. Use Git LFS or cloud storage with a pointer.
- Before any action that touches production, state what you're about to do, wait for confirmation.

## How Kyogrim wants to be talked to

- Direct. Short. Concrete. No preamble.
- Specific file names, function names, line numbers. Not "there's an issue in the classifier" — it's `food_vision/classifier.py:47`.
- No em dashes. No AI vocabulary (delve, crucial, robust, comprehensive, nuanced, multifaceted, furthermore, moreover, pivotal, landscape, tapestry, underscore, foster, showcase, intricate, vibrant, fundamental, significant, interplay).
- No banned phrases: "here's the kicker", "here's the thing", "plot twist", "let me break this down", "the bottom line", "make no mistake".
- If something is broken, say so plainly.
- End responses with the next action, not a recap of what was just done.

When Kyogrim asks for something, the answer is the finished product — not a plan. Tests included. Evals included. Docs included.

---

## This project — Stream Lurker

Everything above is the general contract. This section is specific to this repo, and **where the two
conflict, this section wins.**

### What it is

An Electron desktop app that monitors Twitch / Kick / YouTube channels, auto-opens them when they go
live, and lurks a whole lineup in one window. Releases are Windows-only NSIS installers; nothing has
ever been published for Linux (see "Releasing"). Runs on Electron 44.4.5 (Chromium 152); every release
up to v0.14.0-beta shipped Electron 30 (Chromium 124), which matters for the cookie database (see
"The profile").

Updates are user-triggered, never automatic: System Settings → Check for Updates, then Download
Update, then Restart & Install (a downloaded update also installs on the next quit). Nothing checks in
the background, so a release reaches only the users who click, whenever they click.

### Layout

| Path | Role |
|---|---|
| `main.js` | Main process, the largest file (over 4k lines; `wc -l main.js` for today's count, and read it in pages): windows, sessions/cookies, IPC handlers, the scan loop, config, tray, updater, releases. The decisions it makes live in `main/` |
| `main/*.js` | CommonJS modules for main-process logic, one concern each (config store and sanitizing, cookie import and migration, the extension's local receiver, scan planning, dashboard protocol and health, …). None requires `electron` (Electron objects come in as arguments), so each runs under plain Node in `test/main-<name>.test.js` (two predate that prefix: `cookie-migration` and `safe-unzip` are tested in `test/<name>.test.js`) |
| `preload.js` | `contextBridge` for the dashboard, which runs with `sandbox: true`, so it may only `require('electron')`. Everything the renderer can call lives on `window.api` |
| `renderer.js` | Entry point (ES module): wires modules together, binds main→renderer events |
| `src/*.js` | ES modules loaded from `renderer.js`: one per feature (`multi-lurk`, `leaderboard`, `streamers`, `settings`, `live-now`, `onboarding`, …) plus shared ones (`state.js`, `tabs.js`, and `inject.js`, the scripts injected into platform pages). One exception: `src/twitch-preload.js` is a plain-script preload for the sandboxed login window (`open-login-modal` in `main.js`), not an ES module. Sandboxed preloads cannot be ES modules, so never add `import`/`export` to it |
| `index.html` | One page, served from `app://bundle` (`main/dashboard-protocol.js`), never `file://`; one `<section class="tab-content">` per tab |
| `style.css` | CSS custom properties, dark/cyan theme |
| `extension/` | The "Stream Lurker Connector" browser extension (MV3). `connector.js` holds its protocol, shared by `popup.js`, the `background.js` worker and the tests; the app side is `main/cookie-receiver.js` |
| `test/` | `node:test` gate tests, run by `npm test`: `main-*` (the `main/` modules, plus static guards that read `main.js` as text), `cookie-migration` and `safe-unzip` (two `main/` modules named before the prefix), `renderer-*`, `page-*` (scripts injected into platform pages), `extension-*` |

### Patterns to reuse

- **Adding a tab:** a `data-tab="x"` nav button plus `<section id="tab-x" class="tab-content">`.
  `switchTab` in `src/tabs.js` is generic — no JS change needed.
- **Adding IPC:** always three places — `ipcMain.handle` in `main.js`, a bridge in `preload.js`, a
  `window.api.*` call in the renderer. Use `ipcMain.handle` only: `main.js` wraps it so every handler
  refuses any caller but the dashboard's top frame on `app://bundle`. `test/main-ipc-surface.test.js`
  fails if the preload calls a channel that has no handler.
- **Main-process logic:** put the decision in a `main/<name>.js` module with its inputs passed in,
  test it in `test/main-<name>.test.js`, and leave only the wiring in `main.js`. `main.js` cannot load
  outside Electron, so the `main-*-wiring` tests read it as text to check it still routes through the
  modules.
- **HTML in the renderer:** every value interpolated into `innerHTML` / `insertAdjacentHTML` /
  `outerHTML` goes through `escapeHtml`, or is set with `textContent` / `setAttribute` instead. Every
  URL put in a `src` / `href` goes through `safeHttpsUrl` with the hosts it may point at, unless it
  is a literal `https://` or relative URL. `test/renderer-html-guard.test.js` checks both statically.
- **`index.html`** has no inline `<script>`, no `on*=` handlers and no `javascript:` URLs. The
  Content-Security-Policy blocks them at runtime and `test/renderer-csp.test.js` fails first.
- **No menu shortcuts.** The application menu is removed on Windows and Linux, so Ctrl+R,
  Ctrl+Shift+I and the zoom keys do nothing; never build on them. DevTools opens by itself in an
  unpackaged build and cannot open in a packaged one.
- **Shared helpers** live in `src/state.js` (`fmtDuration`, `formatViewerCount`, `getPlatformSVG`,
  `platformColorVar`, `isPlatformEnabled`, `escapeHtml`, `safeHttpsUrl`). Put anything used by two
  modules there rather than duplicating it.

### The config is irreplaceable

`%APPDATA%/stream-lurker/config.json` holds the monitored list and thousands of hours of watch
history. It is written atomically (temp file → rename) with a rolling `.bak`. Recovery copies sit
next to it as `config.json.<kind>-<stamp>.json`, where `<stamp>` is the ISO 8601 time with `:` and `.`
turned into `-`, e.g. `config.json.corrupt-2026-09-27T14-03-11-123Z.json`:

- `corrupt`: a config.json that read but is not a JSON object, moved aside before the app falls
  back to `.bak` (a damaged `.bak` is copied to `config.json.bak.corrupt-<stamp>.json`).
- `dropped-streamers`: monitored-streamer entries the app could not use.
- `preimport`: the config as it was just before a backup import replaced it.

A config.json that exists but cannot be read (held by a backup or sync tool, a drive not mounted
yet) is never overwritten: the app runs on defaults, saves nothing, and offers Retry
(`main/config-store.js`).

- Back it up before any destructive test.
- Every new field needs a safe default for existing installs — a missing streamer `mode` must read as
  `auto`, or upgraders silently change behaviour.

### The profile: one process, and the cookie database

The platform logins live in the Chromium profile next to config.json, and they are just as hard to
get back.

- **One process per profile.** `app.requestSingleInstanceLock()` runs at the top of `main.js`,
  before anything touches the profile: a second launch on the same profile exits at once and brings
  the running window forward (a `--hidden` launch, the Windows sign-in one, stays in the tray). The
  lock is keyed on the profile directory and binds only processes that ask for it, so it does not
  stop a loose script, or a process started with a different `--user-data-dir`.
- **The cookie schema migration.** Electron 30 stores cookies at schema v21. Chromium 147 dropped
  the migrations from v21, so Electron 42 and later delete such a file and start empty: every login
  gone. `main/cookie-migration.js` replays Chromium's own v21 → v23 steps before Chromium opens the
  file, and Chromium 152 takes it to v24 itself. It must run before `ready` and before any session
  exists; once the network service has the file open it is too late, so never move it later.
- **Rollback hazard: never ship a build on an older Electron than the last release.** Chromium also
  deletes a cookie database that is too new for it, so a v24 file opened by Electron 30 is wiped.
  Never downgrade `electron` in package.json, and never run an older build on a profile a newer one
  has opened (one more reason dev builds get a copy of the profile).
- **Every Electron bump:** users skip versions (updates are user-triggered), so any old release can
  update straight to the new one. Check that the new Chromium still migrates v23, which is what
  `cookie-migration.js` leaves for anyone arriving from an Electron 30 release, and extend the
  migration first if it does not. Prove it on a copy of a real pre-upgrade profile by counting
  cookies before and after.

### Verification

"Tested" here means, in order of cost:

**1. Syntax, one file per call.** `node --check` parses only its first operand; the rest become
`process.argv`, so `node --check main.js preload.js` never looks at preload.js. Both loops feed the
file on stdin with an explicit `--input-type`, because a file operand leaves the parse to Node's
module-syntax detection: that passes `import`/`export` in a CommonJS file, and a sandboxed preload
cannot load ESM, so the preload fails, `window.api` is undefined, and the check passed. Pinned, the
result also does not depend on package.json's `"type"`. `--input-type` applies only to stdin or
`--eval` (with a file operand it is refused outright), and errors read from stdin say `[stdin]`,
which is why each loop names the file. Bash (Git Bash on Windows); PowerShell has no `<` redirection.

```bash
bad=0
# CommonJS and plain scripts, pinned like the ES-module loop: a file operand leaves
# the parse to module-syntax detection, which passes import/export in a CommonJS
# file (and a sandboxed preload cannot load ESM).
for f in main.js preload.js main/*.js src/twitch-preload.js extension/*.js; do
  node --input-type=commonjs --check < "$f" || { echo "SYNTAX: $f"; bad=1; }
done
# ES modules. Errors read from stdin say [stdin], which is why the loop names the file.
for f in renderer.js src/*.js; do
  [ "$f" = src/twitch-preload.js ] && continue   # plain-script preload, checked above
  node --input-type=module --check < "$f" || { echo "SYNTAX: $f"; bad=1; }
done
[ "$bad" = 0 ]
```

**2. `npm test`.** The `node:test` gate tests in `test/**/*.test.js`, in plain Node with no Electron:
the `main/` modules, the extension's connector, the renderer modules and page scripts, plus static
guards over `main.js`, `preload.js` and `index.html`. No pre-commit hook runs them; run them before
every commit. A behavior fix ships with its test here, so logic stuck inside `main.js` gets pulled
into a `main/` module first.

**3. A dev build, on a copy of the profile.** Never run unreleased code on the live profile. `npm
start` without a switch uses it: while the app is running the lock just hands off to it and exits,
and with the app closed your build runs on the real cookies and config. Electron 44 honors
`--user-data-dir`: `app.getPath('userData')` returns it and the single-instance lock is keyed on it,
so the copy runs next to the real app without handing off.

Electron ignores an empty `--user-data-dir`, and one it cannot create, and runs on
`%APPDATA%/stream-lurker`, so run the block as **one** bash invocation (save it to a file and
`bash file.sh` if the harness refuses it), never line by line, because `SL_PROFILE` does not survive
between tool calls. Every step is chained into the launch, and the launch line checks for a finished
copy itself, so a failed step, the placeholder left in, or the last line run alone starts nothing.
`npx electron` returns only when the dev build quits, so run the whole invocation in the background.

```bash
# Quit the app first (tray > Quit Stream Lurker): a copy taken mid-write can be torn.
SL_PROFILE="<your scratchpad>/sl-profile"   # <- a path that does not exist yet, never under %APPDATA%
# The copy keeps launchOnStartup, and a dev build that sees it on registers
# node_modules' electron.exe as a Windows sign-in entry, so it is switched off.
# The marker is written only after that, and the launch refuses a folder without
# it; the check shares the launch's line so no split of this block runs it bare.
# (npx electron . is the same as npm start --)
mkdir "$SL_PROFILE" && cp -r "$APPDATA/stream-lurker/." "$SL_PROFILE" &&
node -e "const f=process.argv[1],fs=require('fs'),c=JSON.parse(fs.readFileSync(f,'utf8'));c.launchOnStartup=false;fs.writeFileSync(f,JSON.stringify(c,null,2))" "$SL_PROFILE/config.json" &&
touch "$SL_PROFILE/.sl-dev-copy" &&
[ -n "$SL_PROFILE" ] && [ -f "$SL_PROFILE/.sl-dev-copy" ] && npx electron . --user-data-dir="$SL_PROFILE"
```

The copy keeps the streamer list and Auto-Open, so it scans and opens streams like the real app. It
also keeps the pairing code: with the real app closed, the browser extension's 30-minute re-sync
lands in the copy.

Running the block again stops at `mkdir`, because the copy exists. To start the same copy again, run
the `SL_PROFILE=` line and the last line, together in one invocation. The marker check refuses an
empty path, the live profile, and a copy the block did not finish (delete that one and run the block
again).

For pure logic, a test in `test/` beats a throwaway harness; a harness in the scratchpad is fine
for exploring real cases first. Do not claim something works because it parses.

### Releasing

```bash
# 0. both syntax loops and npm test pass, and a dev build ran on a copy of a real profile
# 1. bump version in package.json, then:
npm install --package-lock-only
git commit && git tag -a vX.Y.Z-beta && git push origin main && git push origin vX.Y.Z-beta
# 2. stop the running app first — the build hits file locks otherwise
GH_TOKEN="$(gh auth token)" npm run release
gh release edit vX.Y.Z-beta --title "Stream Lurker vX.Y.Z-beta" --notes "..." --latest
```

`build.publish.releaseType` is `release`, so it publishes live — there is no draft step to clean up.

- **Electron never goes backwards** between releases (see "The profile").
- **A release reaches only users who click Check for Updates**, whenever they get to it. There is no
  recalling a bad one from anyone who installed it, and a fix does not reach anyone who does not
  check, so when a fix matters, say so in the release notes.
- **Windows only.** `npm run release` publishes the NSIS installer and `latest.yml`. Do not run
  `release-linux`: it puts an untested AppImage and `latest-linux.yml` on the same tag. Linux needs
  its own tested release step first.
- **The extension ships inside the installer** (`build.extraResources`, loaded unpacked), and a
  browser can keep running an older copy of it long after the app updates. A release must keep
  working with older extension versions: that is why the receiver still takes `body.pairingCode`
  and why ports 47100-47104 stay first on both sides.

### Windows / Git Bash gotchas

- `taskkill /PID` must run through **PowerShell**. Git Bash rewrites `/PID` into a filesystem path.
- `gh api` endpoints take **no leading slash** (`gh api markdown`, not `gh api /markdown`).
- Python reading the config must pass `encoding='utf-8'` — stream titles contain emoji.
- The syntax loops in "Verification" are bash; PowerShell has no `<` redirection.

### Three rules learned the hard way

- **Never `git checkout <file>` to unwind a temporary patch** while that file holds uncommitted work.
  It discards everything, not just the patch. Commit first, or revert the patch with a targeted edit.
- **Don't trust bare-HTTP auth checks against Google.** Fetching youtube.com with the cookie jar
  returns `"LOGGED_IN":false` for sessions that are perfectly alive in a real browser context.
  Verify auth inside a webview (`window.ytcfg.get('LOGGED_IN')`), never from a plain request.
- **Never point a second Electron process at the live user profile.** Two processes sharing one
  Chromium profile (`%APPDATA%/stream-lurker`) can wipe the cookie store — a full set of platform
  logins was destroyed this way by a throwaway test script overlapping the running app. Copy the
  profile to the scratchpad and start the script with `--user-data-dir=<the copy>`, and close the
  app first either way. The single-instance lock does not save you here: a script that never asks
  for it is never refused. Without the switch, a loose script uses `%APPDATA%/<its package.json
  productName or name>` (`%APPDATA%/Electron` for a bare script), a profile with none of the app's
  cookies, so its results are meaningless. Electron ignores an empty `--user-data-dir`, and one it
  cannot create, exactly as if the switch were missing, and `electron .` from this repo then runs on
  `%APPDATA%/stream-lurker`, the live profile. So set the path and launch in **one** bash
  invocation (a file run with `bash file.sh` if the harness refuses the block), with the launch
  guarded as in Verification step 3, never across tool calls: a variable does not survive between
  them.

### Miscellany

- Rumble is scaffolded but force-disabled (`config.rumbleEnabled = false` on every load). Don't
  advertise it as working.
- Comments explain *why*, not *what*, and match the density of the surrounding file.
- The app is beta and ships to real users. Updates are user-triggered (System Settings → Check for
  Updates), so a bad release reaches everyone who checks and cannot be taken back, and a fix
  reaches only those who check again. Get it right before it ships.
