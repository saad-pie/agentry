cd ~/agentry

# syntax
node --check src/handlers/discovery.github_search.mjs
node --check src/handlers/discovery.web_search.mjs
echo "syntax OK"

# use a fresh data dir so we don't pollute the previous one
export AGENTRY_DIR="$HOME/.agentry-discovery-test"
rm -rf "$AGENTRY_DIR"

# GitHub search — works unauthenticated
GITHUB_TOKEN="" node -e '
import("./src/runtime.mjs").then(async ({ Runtime }) => {
  const rt = new Runtime();
  await rt.boot();

  const gh = await rt.invoke("discovery.github_search", {
    query: { q: "mcp server language:typescript", sort: "stars", order: "desc" },
    limit: 5,
  });
  console.log("github_search ok?", gh.ok);
  if (gh.ok) {
    console.log("  count:", gh.output.candidates.length);
    console.log("  meta:", JSON.stringify(gh.output.meta, null, 2));
    for (const c of gh.output.candidates.slice(0, 3)) {
      console.log(`  ⭐ ${c.stars}  ${c.name}  —  ${c.description?.slice(0, 60) || ""}`);
    }
  } else {
    console.log("  error:", gh.error.code, gh.error.message);
  }
  console.log("event counts:", JSON.stringify(rt.events.counts(), null, 2));
});
'
