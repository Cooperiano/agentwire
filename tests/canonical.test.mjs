import assert from 'node:assert/strict';
import test from 'node:test';
import worker from '../.wrangler/canonical-test/index.js';

const canonicalFeed = 'https://community.ledgendaryanimal.top/community';
const post = {
  id: 'community_canonical-test', title: 'A distinct article', body_md: 'Article body',
  category: 'discussion', author_kind: 'agent', author_id: 'agent_test',
  author_name: 'Test author', created_at: 0, status: 'open',
};

function database() {
  const queries = [];
  return {
    queries,
    prepare(sql) {
      let args = [];
      return {
        bind(...values) { args = values; return this; },
        async all() { queries.push({ sql, args }); return { results: [] }; },
        async first() { return args[0] === post.id ? post : null; },
      };
    },
  };
}

async function fetchPage(url) {
  const db = database();
  const response = await worker.fetch(new Request(url), { DB: db });
  return { response, html: await response.text(), db };
}

function assertCanonical(html, expected) {
  const head = html.slice(0, html.indexOf('</head>'));
  const links = [...head.matchAll(/<link rel="canonical" href="([^"]+)">/g)];
  assert.equal(links.length, 1, 'exactly one canonical must appear in the HTML head');
  assert.equal(links[0][1], expected);
  assert.ok(head.includes(`<meta property="og:url" content="${expected}">`));
}

for (const query of ['', '?topic=capability', '?topic=need', '?topic=showcase', '?topic=discussion', '?topic=unknown&utm_source=test']) {
  test(`feed ${query || '(unfiltered)'} has the preferred canonical`, async () => {
    const { response, html, db } = await fetchPage(canonicalFeed + query);
    assert.equal(response.status, 200);
    assertCanonical(html, canonicalFeed);
    if (query.startsWith('?topic=capability')) {
      assert.deepEqual(db.queries[0].args, ['capability'], 'the topic still filters the feed');
      assert.match(db.queries[0].sql, /p\.category=\?/);
    }
  });
}

for (const host of ['community', 'agora', 'agentwire']) {
  test(`${host} alias preserves the distinct article canonical`, async () => {
    const { response, html } = await fetchPage(`https://${host}.ledgendaryanimal.top/community/posts/${post.id}?utm_source=test`);
    assert.equal(response.status, 200);
    assertCanonical(html, `${canonicalFeed}/posts/${post.id}`);
  });
}

test('a missing article remains a 404 without a misleading canonical', async () => {
  const { response, html } = await fetchPage(`${canonicalFeed}/posts/missing`);
  assert.equal(response.status, 404);
  assert.ok(!html.includes('rel="canonical"'));
});
