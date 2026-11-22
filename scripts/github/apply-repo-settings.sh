#!/usr/bin/env bash
# Applies the repository settings for the public Fireside repositories with
# `gh api`: merging, features, metadata, rulesets for the default branch and
# release tags, security features and Actions permissions. See
# docs/decisions/0016-release-setup.md and CONTRIBUTING.md "Releases".
#
# Usage: scripts/github/apply-repo-settings.sh <owner/repo> <branch> <profile> [--dry-run]
#   branch   the default branch (main, or master for the plugin)
#   profile  app (fireside), plugin (fireside-plugin) or site (fireside-site)
#   --dry-run  print every call and its JSON body, send nothing (needs no gh)
#
# Idempotent: every call sets a state (PATCH/PUT), and rulesets are updated
# by name instead of added again, so it can be run as often as needed.
#
# On GitHub Free, rulesets, secret scanning, private vulnerability reporting
# and CodeQL need a public repository. On a private one they are skipped and
# listed at the end, so run it again once the repository is public. Any other
# call that fails is listed too, and the script exits with 1.
#
# The required status checks are the job names of the checks every pull
# request must pass. For app they must match the `name:` of jobs in
# .github/workflows/ (checked by apply-repo-settings.test.ts).
set -euo pipefail

usage() {
  echo "Usage: $0 <owner/repo> <branch> <app|plugin|site> [--dry-run]" >&2
  exit 2
}

[ "$#" -ge 3 ] || usage
repo="$1"
branch="$2"
profile="$3"
dry_run=false
case "${4:-}" in
  '') ;;
  --dry-run) dry_run=true ;;
  *) usage ;;
esac
[[ "$repo" =~ ^[A-Za-z0-9-]+/[A-Za-z0-9._-]+$ ]] || usage

homepage='https://fireside.tools'

# Per profile: description, topics, issues on or off, CodeQL languages (empty:
# no CodeQL) and the required status checks (empty: no checks rule).
case "$profile" in
  app)
    description='Self-hosted tracker for Old School RuneScape: server and dashboard for the Fireside RuneLite plugin.'
    topics=(oldschool-runescape osrs runelite self-hosted dashboard tracker sqlite fastify react typescript)
    has_issues=true
    codeql_languages=(javascript-typescript)
    required_checks=('Lint, test and build' 'Docs' 'CSP in Chromium' 'Docker image' 'PR title' 'Gitleaks')
    ;;
  plugin)
    description='RuneLite plugin for Fireside, a self-hosted tracker for Old School RuneScape.'
    topics=(oldschool-runescape osrs runelite runelite-plugin self-hosted tracker java)
    has_issues=true
    codeql_languages=(java-kotlin)
    required_checks=('Gradle build' 'PR title' 'Gitleaks')
    ;;
  site)
    description='The website for Fireside, a self-hosted tracker for Old School RuneScape.'
    topics=(oldschool-runescape osrs runelite self-hosted website)
    has_issues=false
    codeql_languages=()
    required_checks=()
    ;;
  *) usage ;;
esac

# GitHub Actions' app ID, so a required check can only be met by a workflow.
actions_app_id=15368

skipped=()
failed=()

# call <label> <METHOD> <path> [json]: sends one request, or prints it in a
# dry run. A failure is recorded and the script goes on.
call() {
  local label="$1" method="$2" path="$3" body="${4:-}" out
  if $dry_run; then
    printf '%s\t%s %s\t%s\n' "$label" "$method" "$path" "$(jq -c . <<< "${body:-null}")"
    return 0
  fi
  if [ -n "$body" ]; then
    out="$(gh api --method "$method" "$path" --input - <<< "$body" 2>&1 > /dev/null)" || {
      failed+=("$label: $out")
      echo "FAILED  $label"
      return 0
    }
  else
    out="$(gh api --method "$method" "$path" 2>&1 > /dev/null)" || {
      failed+=("$label: $out")
      echo "FAILED  $label"
      return 0
    }
  fi
  echo "OK      $label"
}

# A setting that needs a public repository on GitHub Free.
public_only() {
  local label="$1"
  shift
  if [ "$visibility" = public ]; then
    call "$label" "$@"
  else
    skipped+=("$label")
    echo "SKIPPED $label (needs a public repository)"
  fi
}

# upsert_ruleset <label> <json>: updates the ruleset with the same name, or
# creates it.
upsert_ruleset() {
  local label="$1" body="$2" name id
  name="$(jq -r .name <<< "$body")"
  if $dry_run; then
    call "$label" PUT-OR-POST "repos/$repo/rulesets" "$body"
    return 0
  fi
  if [ "$visibility" != public ]; then
    skipped+=("$label")
    echo "SKIPPED $label (needs a public repository)"
    return 0
  fi
  id="$(gh api "repos/$repo/rulesets?includes_parents=false" \
    --jq ".[] | select(.name == \"$name\") | .id" 2>/dev/null | head -n 1)" || id=''
  if [ -n "$id" ]; then
    call "$label" PUT "repos/$repo/rulesets/$id" "$body"
  else
    call "$label" POST "repos/$repo/rulesets" "$body"
  fi
}

if $dry_run; then
  visibility=public
  echo "# Dry run for $repo ($profile, branch $branch): nothing is sent." >&2
else
  command -v gh > /dev/null || { echo "gh is not installed" >&2; exit 2; }
  info="$(gh api "repos/$repo" --jq '[.visibility, .default_branch] | @tsv')"
  visibility="$(cut -f 1 <<< "$info")"
  default_branch="$(cut -f 2 <<< "$info")"
  if [ "$default_branch" != "$branch" ]; then
    echo "The default branch of $repo is $default_branch, not $branch." >&2
    exit 2
  fi
  echo "$repo is $visibility; applying profile $profile."
fi

# --- Merging, features and metadata ------------------------------------------
# The squash commit is the PR title only (message BLANK): release-please reads
# every "type:" line of a commit message as its own change, so a description
# such as Dependabot's upstream release notes would add changelog entries and
# could bump the version. See docs/decisions/0016-release-setup.md.
call 'Merging, features and metadata' PATCH "repos/$repo" "$(jq -n \
  --arg description "$description" --arg homepage "$homepage" \
  --argjson has_issues "$has_issues" '{
    allow_squash_merge: true,
    allow_merge_commit: false,
    allow_rebase_merge: false,
    squash_merge_commit_title: "PR_TITLE",
    squash_merge_commit_message: "BLANK",
    delete_branch_on_merge: true,
    allow_auto_merge: true,
    allow_update_branch: true,
    has_issues: $has_issues,
    has_wiki: false,
    has_projects: false,
    has_discussions: false,
    description: $description,
    homepage: $homepage
  }')"

call 'Topics' PUT "repos/$repo/topics" "$(jq -n '{names: $ARGS.positional}' --args "${topics[@]}")"

# --- Rulesets ----------------------------------------------------------------
# Default branch: changes only through a pull request (no approval needed, so
# a single maintainer can merge), squash only, checks green on an up-to-date
# branch, linear history, no force push or deletion. Nobody can bypass it.
checks_json="$(jq -n --argjson app "$actions_app_id" \
  '[$ARGS.positional[] | {context: ., integration_id: $app}]' --args "${required_checks[@]}")"
upsert_ruleset 'Ruleset: default branch' "$(jq -n --arg ref "refs/heads/$branch" \
  --argjson checks "$checks_json" '{
    name: "default branch",
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: {ref_name: {include: [$ref], exclude: []}},
    rules: ([
      {type: "deletion"},
      {type: "non_fast_forward"},
      {type: "required_linear_history"},
      {type: "pull_request", parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
        allowed_merge_methods: ["squash"]
      }}
    ] + (if ($checks | length) > 0 then [
      {type: "required_status_checks", parameters: {
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: false,
        required_status_checks: $checks
      }}
    ] else [] end))
  }')"

# Release tags: once pushed, never moved or deleted. Creating them stays
# allowed (no "creation" rule), so release-please can tag v<version> and
# maintainers can push contract-v<version>.
upsert_ruleset 'Ruleset: release tags' "$(jq -n '{
    name: "release tags",
    target: "tag",
    enforcement: "active",
    bypass_actors: [],
    conditions: {ref_name: {include: ["refs/tags/v*", "refs/tags/contract-v*"], exclude: []}},
    rules: [{type: "update"}, {type: "deletion"}]
  }')"

# --- Security ----------------------------------------------------------------
call 'Dependabot alerts' PUT "repos/$repo/vulnerability-alerts"
call 'Dependabot security updates' PUT "repos/$repo/automated-security-fixes"
public_only 'Secret scanning and push protection' PATCH "repos/$repo" "$(jq -n '{
    security_and_analysis: {
      secret_scanning: {status: "enabled"},
      secret_scanning_push_protection: {status: "enabled"}
    }
  }')"
public_only 'Private vulnerability reporting' PUT "repos/$repo/private-vulnerability-reporting"
if [ "${#codeql_languages[@]}" -gt 0 ]; then
  public_only "CodeQL default setup (${codeql_languages[*]})" PATCH \
    "repos/$repo/code-scanning/default-setup" \
    "$(jq -n '{state: "configured", query_suite: "default", languages: $ARGS.positional}' \
      --args "${codeql_languages[@]}")"
fi

# --- Actions -----------------------------------------------------------------
# GITHUB_TOKEN is read-only unless a workflow asks for more, and workflows
# can't approve pull requests.
call 'Actions: workflow permissions' PUT "repos/$repo/actions/permissions/workflow" \
  '{"default_workflow_permissions": "read", "can_approve_pull_request_reviews": false}'
# Workflows from forks wait for approval unless the author is a collaborator.
call 'Actions: fork pull request approval' PUT \
  "repos/$repo/actions/permissions/fork-pr-contributor-approval" \
  '{"approval_policy": "all_external_contributors"}'

# --- Summary -----------------------------------------------------------------
$dry_run && exit 0
if [ "${#skipped[@]}" -gt 0 ]; then
  echo
  echo 'Skipped (needs a public repository; run this again once it is public):'
  printf '  - %s\n' "${skipped[@]}"
fi
if [ "${#failed[@]}" -gt 0 ]; then
  echo
  echo 'Failed:'
  printf '  - %s\n' "${failed[@]}"
  exit 1
fi
echo
echo 'Done.'
