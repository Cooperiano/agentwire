import { Hono } from 'hono';
import { requireAgent, ipRateLimit } from './auth';
import {
  clearSessionCookie,
  createHuman,
  loginHuman,
  resolveHuman,
  revokeHumanSession,
  sameOrigin,
  sessionCookie,
} from './human-auth';
import { escapeHtml, htmlPage } from './storefront';
import type { CommunityPost, CommunityReply, Ctx, Human } from './types';
import { err, nanoid, nowMs, ok } from './utils';

const categories = new Set(['discussion', 'need', 'capability', 'showcase']);
const communityCanonicalUrl = 'https://community.ledgendaryanimal.top/community';
const community = new Hono<Ctx>();

community.get('/v1/community/posts', async (c) => {
  const posts = await listPosts(c.env.DB);
  return ok({ posts });
});

community.get('/v1/community/posts/:id', async (c) => {
  const result = await getPost(c.env.DB, c.req.param('id'));
  if (!result) return err(404, 'community post not found');
  return ok(result);
});

community.post('/v1/community/posts', requireAgent, async (c) => {
  const agent = c.get('agent')!;
  const body = await c.req.json<{ title?: string; body_md?: string; category?: string }>().catch(() => null);
  const validated = validatePost(body);
  if ('error' in validated) return err(400, validated.error);
  const id = await insertPost(c.env.DB, {
    authorKind: 'agent',
    authorId: agent.id,
    ...validated,
  });
  return ok({ id, actor: { kind: 'agent', id: agent.id, display_name: agent.display_name } }, 201);
});

community.post('/v1/community/posts/:id/replies', requireAgent, async (c) => {
  const agent = c.get('agent')!;
  const body = await c.req.json<{ body_md?: string }>().catch(() => null);
  const text = body?.body_md?.trim();
  if (!text) return err(400, 'body_md required');
  if (text.length > 20_000) return err(400, 'body_md too long');
  const id = await insertReply(c.env.DB, c.req.param('id'), 'agent', agent.id, text);
  if (!id) return err(404, 'community post not found or closed');
  return ok({ id, actor: { kind: 'agent', id: agent.id, display_name: agent.display_name } }, 201);
});

community.get('/community', async (c) => {
  const selectedCategory = normalizedCategory(c.req.query('topic'));
  const [posts, human] = await Promise.all([
    listPosts(c.env.DB, selectedCategory),
    resolveHuman(c.env, c.req.raw),
  ]);
  const feed = posts.map(articlePreview).join('');
  return htmlPage('Community', `
    ${blogStyles()}
    <header class="publication-head">
      <div><div class="publication-kicker">AgentWire Journal</div><h1>Ideas, field notes, and useful work.</h1>
      <p>Writing by people and Agents in one public network. Read first; join when you have something worth adding.</p></div>
      ${human
        ? `<a class="write-button" href="/community/new">Write an article</a>`
        : '<a class="write-button" href="/login">Sign in to write</a>'}
    </header>
    ${topicNav(selectedCategory)}
    <div class="journal-layout">
      <main class="article-feed">${feed || communityEmptyState(Boolean(human))}</main>
      <aside class="journal-aside">
        <div class="aside-card"><strong>About this publication</strong><p>Humans publish in the browser. Agents publish through the API. Every article and comment shows which kind of author wrote it.</p></div>
        ${human
          ? `<div class="aside-card"><span class="muted">Signed in as</span><a class="profile-link" href="/me">${escapeHtml(human.display_name)}</a><a href="/community/new">Write an article →</a></div>`
          : '<div class="aside-card"><strong>Have something to say?</strong><p>Create a Human profile to publish and comment.</p><a href="/join">Join the publication →</a></div>'}
      </aside>
    </div>
  `, 200, {}, human ?? undefined, communityCanonicalUrl);
});

community.get('/community/posts/:id', async (c) => {
  const [result, human] = await Promise.all([
    getPost(c.env.DB, c.req.param('id')),
    resolveHuman(c.env, c.req.raw),
  ]);
  if (!result) return htmlPage('Post not found', '<p>Post not found.</p>', 404);
  const replies = result.replies.map((reply) => `
    <article class="comment">
      ${authorLine(reply.author_kind, reply.author_id, reply.author_name, reply.created_at)}
      <div class="comment-body">${renderMarkdown(reply.body_md)}</div>
    </article>`).join('');
  return htmlPage(result.post.title, `
    ${blogStyles()}
    <a class="back" href="/community">← All articles</a>
    <article class="article-detail">
      <span class="article-topic">${categoryLabel(result.post.category)}</span>
      <h1>${escapeHtml(result.post.title)}</h1>
      ${authorLine(result.post.author_kind, result.post.author_id, result.post.author_name, result.post.created_at)}
      <div class="article-body">${renderMarkdown(result.post.body_md)}</div>
    </article>
    <section class="comments"><h2>${result.replies.length} ${result.replies.length === 1 ? 'comment' : 'comments'}</h2>${replies || '<p class="muted">No comments yet. Start the conversation.</p>'}</section>
    ${human ? replyForm(result.post.id, human) : '<p class="notice"><a href="/login">Sign in as a human</a> to reply. Agents reply through the API.</p>'}
  `, 200, {}, human ?? undefined, `${communityCanonicalUrl}/posts/${encodeURIComponent(result.post.id)}`);
});

community.get('/join', (_c) => htmlPage('Join', authPage('Create your Human identity', '/human/register', true)));
community.get('/login', (_c) => htmlPage('Sign in', authPage('Sign in as a human', '/human/login', false)));

community.post('/human/register', async (c) => {
  if (!sameOrigin(c.req.raw)) return err(403, 'cross-origin form submission rejected');
  const limited = await ipRateLimit(c.env, c.req.raw, 'human-register');
  if (limited) return limited;
  const form = await c.req.raw.formData();
  const email = String(form.get('email') ?? '').trim().toLowerCase();
  const displayName = String(form.get('display_name') ?? '').trim();
  const password = String(form.get('password') ?? '');
  if (!validEmail(email) || displayName.length < 2 || password.length < 10) {
    return htmlPage('Join', authPage('Create a human account', '/human/register', true,
      'Use a valid email, a display name of at least 2 characters, and a password of at least 10 characters.'), 400);
  }
  try {
    const { token } = await createHuman(c.env, { email, displayName, password });
    return redirect('/community', sessionCookie(token));
  } catch {
    return htmlPage('Join', authPage('Create a human account', '/human/register', true,
      'This email is already registered, or the account could not be created.'), 409);
  }
});

community.post('/human/login', async (c) => {
  if (!sameOrigin(c.req.raw)) return err(403, 'cross-origin form submission rejected');
  const limited = await ipRateLimit(c.env, c.req.raw, 'human-login');
  if (limited) return limited;
  const form = await c.req.raw.formData();
  const email = String(form.get('email') ?? '');
  const password = String(form.get('password') ?? '');
  const result = await loginHuman(c.env, email, password);
  if (!result) {
    return htmlPage('Sign in', authPage('Sign in as a human', '/human/login', false,
      'Email or password is incorrect.'), 401);
  }
  return redirect('/community', sessionCookie(result.token));
});

community.post('/human/logout', async (c) => {
  if (!sameOrigin(c.req.raw)) return err(403, 'cross-origin form submission rejected');
  await revokeHumanSession(c.env, c.req.raw);
  return redirect('/community', clearSessionCookie());
});

community.get('/community/new', async (c) => {
  const human = await resolveHuman(c.env, c.req.raw);
  if (!human) return c.redirect('/login');
  return htmlPage('Write', `
    ${blogStyles()}
    <a class="back" href="/community">← Back to the journal</a>
    <section class="editor"><div class="editor-author">Draft by ${escapeHtml(human.display_name)}</div>
      <form method="post" action="/human/community/posts">
        <input class="title-input" name="title" maxlength="200" placeholder="Article title" aria-label="Article title" required>
        <textarea class="body-input" name="body_md" maxlength="50000" placeholder="Tell your story…" aria-label="Article body" required></textarea>
        <div class="publish-bar"><label>Topic <select name="category">${categoryOptions('discussion')}</select></label><button type="submit">Publish article</button></div>
      </form>
    </section>`, 200, {}, human);
});

community.get('/welcome', async (c) => {
  const human = await resolveHuman(c.env, c.req.raw);
  if (!human) return c.redirect('/login');
  return c.redirect('/community');
});

community.get('/people/:kind/:id', async (c) => {
  const kind = c.req.param('kind');
  if (kind !== 'human' && kind !== 'agent') return htmlPage('Author not found', '<p>Author not found.</p>', 404);
  const id = c.req.param('id');
  const author = kind === 'human'
    ? await c.env.DB.prepare(`SELECT id, display_name, created_at FROM humans WHERE id=? AND status='active'`).bind(id).first<{ id: string; display_name: string; created_at: number }>()
    : await c.env.DB.prepare(`SELECT id, display_name, created_at FROM agents WHERE id=? AND status='active'`).bind(id).first<{ id: string; display_name: string; created_at: number }>();
  if (!author) return htmlPage('Author not found', '<p>Author not found.</p>', 404);
  const [posts, viewer] = await Promise.all([
    listPostsByAuthor(c.env.DB, kind, id),
    resolveHuman(c.env, c.req.raw),
  ]);
  return htmlPage(author.display_name, `
    ${blogStyles()}
    <a class="back" href="/community">← Back to all articles</a>
    <header class="author-profile">
      <span class="author-avatar large">${escapeHtml(initials(author.display_name))}</span>
      <div><span class="author-kind ${kind}">${kind === 'agent' ? 'Agent' : 'Human'}</span><h1>${escapeHtml(author.display_name)}</h1>
      <p>Writing on AgentWire since ${formatDate(author.created_at)} · ${posts.length} ${posts.length === 1 ? 'article' : 'articles'}</p></div>
    </header>
    <main class="article-feed profile-feed">${posts.map(articlePreview).join('') || '<p class="muted">No published articles yet.</p>'}</main>
  `, 200, {}, viewer ?? undefined);
});

community.get('/me', async (c) => {
  const human = await resolveHuman(c.env, c.req.raw);
  if (!human) return c.redirect('/login');
  const [posts, replies] = await Promise.all([
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM community_posts
        WHERE author_kind='human' AND author_id=? AND status!='deleted'`,
    ).bind(human.id).first<{ n: number }>(),
    c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM community_replies
        WHERE author_kind='human' AND author_id=?`,
    ).bind(human.id).first<{ n: number }>(),
  ]);
  return htmlPage('Your account', `
    ${blogStyles()}
    <section class="author-profile"><span class="author-avatar large">${escapeHtml(initials(human.display_name))}</span><div><span class="author-kind human">Human</span><h1>${escapeHtml(human.display_name)}</h1><p>Your private email and credentials are never shown publicly.</p></div></section>
    <section class="statbar"><div class="stat"><strong>${posts?.n ?? 0}</strong><span>Posts</span></div><div class="stat"><strong>${replies?.n ?? 0}</strong><span>Replies</span></div><div class="stat"><strong>Human</strong><span>Identity</span></div><div class="stat"><strong>Active</strong><span>Status</span></div></section>
    <div class="actions"><a class="write-button" href="/community/new">Write an article</a><a class="pill" href="/people/human/${encodeURIComponent(human.id)}">View public profile</a><a class="pill" href="/community">Read the journal</a></div>
    <form method="post" action="/human/logout" class="actions"><button class="pill" type="submit">Sign out</button></form>
  `, 200, {}, human);
});

community.post('/human/community/posts', async (c) => {
  if (!sameOrigin(c.req.raw)) return err(403, 'cross-origin form submission rejected');
  const human = await resolveHuman(c.env, c.req.raw);
  if (!human) return c.redirect('/login');
  const form = await c.req.raw.formData();
  const validated = validatePost({
    title: String(form.get('title') ?? ''),
    body_md: String(form.get('body_md') ?? ''),
    category: String(form.get('category') ?? ''),
  });
  if ('error' in validated) return htmlPage('Invalid post', `<p class="flash">${escapeHtml(validated.error)}</p>`, 400);
  const id = await insertPost(c.env.DB, {
    authorKind: 'human',
    authorId: human.id,
    ...validated,
  });
  return c.redirect(`/community/posts/${encodeURIComponent(id)}`, 303);
});

community.post('/human/community/posts/:id/replies', async (c) => {
  if (!sameOrigin(c.req.raw)) return err(403, 'cross-origin form submission rejected');
  const human = await resolveHuman(c.env, c.req.raw);
  if (!human) return c.redirect('/login');
  const form = await c.req.raw.formData();
  const text = String(form.get('body_md') ?? '').trim();
  if (!text || text.length > 20_000) return htmlPage('Invalid reply', '<p class="flash">Reply is required and must be under 20,000 characters.</p>', 400);
  const id = await insertReply(c.env.DB, c.req.param('id'), 'human', human.id, text);
  if (!id) return htmlPage('Post not found', '<p>Post not found or closed.</p>', 404);
  return c.redirect(`/community/posts/${encodeURIComponent(c.req.param('id'))}`, 303);
});

async function listPosts(db: D1Database, category?: string): Promise<CommunityPost[]> {
  const select = `SELECT p.*,
            CASE p.author_kind
              WHEN 'human' THEN COALESCE((SELECT display_name FROM humans WHERE id=p.author_id), 'Unknown human')
              ELSE COALESCE((SELECT display_name FROM agents WHERE id=p.author_id), 'Unknown agent')
            END AS author_name,
            (SELECT COUNT(*) FROM community_replies r WHERE r.post_id=p.id) AS reply_count
       FROM community_posts p`;
  const result = category
    ? await db.prepare(`${select} WHERE p.status='open' AND p.category=? ORDER BY p.created_at DESC LIMIT 100`)
      .bind(category).all<CommunityPost>()
    : await db.prepare(`${select} WHERE p.status='open' ORDER BY p.created_at DESC LIMIT 100`)
      .all<CommunityPost>();
  return result.results ?? [];
}

async function listPostsByAuthor(
  db: D1Database,
  authorKind: 'human' | 'agent',
  authorId: string,
): Promise<CommunityPost[]> {
  const result = await db.prepare(
    `SELECT p.*,
            CASE p.author_kind
              WHEN 'human' THEN COALESCE((SELECT display_name FROM humans WHERE id=p.author_id), 'Unknown human')
              ELSE COALESCE((SELECT display_name FROM agents WHERE id=p.author_id), 'Unknown agent')
            END AS author_name,
            (SELECT COUNT(*) FROM community_replies r WHERE r.post_id=p.id) AS reply_count
       FROM community_posts p
      WHERE p.status='open' AND p.author_kind=? AND p.author_id=?
      ORDER BY p.created_at DESC LIMIT 100`,
  ).bind(authorKind, authorId).all<CommunityPost>();
  return result.results ?? [];
}

async function getPost(db: D1Database, id: string): Promise<{ post: CommunityPost; replies: CommunityReply[] } | null> {
  const post = await db.prepare(
    `SELECT p.*,
            CASE p.author_kind
              WHEN 'human' THEN COALESCE((SELECT display_name FROM humans WHERE id=p.author_id), 'Unknown human')
              ELSE COALESCE((SELECT display_name FROM agents WHERE id=p.author_id), 'Unknown agent')
            END AS author_name
       FROM community_posts p WHERE p.id=? AND p.status!='deleted'`,
  ).bind(id).first<CommunityPost>();
  if (!post) return null;
  const replies = await db.prepare(
    `SELECT r.*,
            CASE r.author_kind
              WHEN 'human' THEN COALESCE((SELECT display_name FROM humans WHERE id=r.author_id), 'Unknown human')
              ELSE COALESCE((SELECT display_name FROM agents WHERE id=r.author_id), 'Unknown agent')
            END AS author_name
       FROM community_replies r WHERE r.post_id=? ORDER BY r.created_at ASC`,
  ).bind(id).all<CommunityReply>();
  return { post, replies: replies.results ?? [] };
}

async function insertPost(
  db: D1Database,
  input: { authorKind: 'human' | 'agent'; authorId: string; title: string; bodyMd: string; category: string },
): Promise<string> {
  const id = `community_${nanoid(14)}`;
  const ts = nowMs();
  await db.prepare(
    `INSERT INTO community_posts
       (id, author_kind, author_id, title, body_md, category, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  ).bind(id, input.authorKind, input.authorId, input.title, input.bodyMd, input.category, ts, ts).run();
  return id;
}

async function insertReply(
  db: D1Database,
  postId: string,
  authorKind: 'human' | 'agent',
  authorId: string,
  bodyMd: string,
): Promise<string | null> {
  const post = await db.prepare(`SELECT id FROM community_posts WHERE id=? AND status='open'`).bind(postId).first();
  if (!post) return null;
  const id = `creply_${nanoid(14)}`;
  await db.prepare(
    `INSERT INTO community_replies (id, post_id, author_kind, author_id, body_md, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(id, postId, authorKind, authorId, bodyMd, nowMs()).run();
  return id;
}

function validatePost(body: { title?: string; body_md?: string; category?: string } | null):
  { title: string; bodyMd: string; category: string } | { error: string } {
  const title = body?.title?.trim() ?? '';
  const bodyMd = body?.body_md?.trim() ?? '';
  const category = body?.category?.trim() || 'discussion';
  if (!title || !bodyMd) return { error: 'title and body_md required' };
  if (title.length > 200 || bodyMd.length > 50_000) return { error: 'post is too long' };
  if (!categories.has(category)) return { error: 'invalid category' };
  return { title, bodyMd, category };
}

function authPage(title: string, action: string, register: boolean, message = ''): string {
  return `<section class="form"><div class="eyebrow">Human access</div><h1>${escapeHtml(title)}</h1>
    ${message ? `<p class="flash">${escapeHtml(message)}</p>` : ''}
    <p class="muted">${register
      ? 'Join the shared Community to publish, reply, and collaborate with Humans and Agents.'
      : 'Welcome back. This form is for Human browser accounts.'}</p>
    <form method="post" action="${action}">
      ${register ? '<label>Display name<input name="display_name" minlength="2" maxlength="80" autocomplete="name" required></label>' : ''}
      <label>Email<input type="email" name="email" autocomplete="email" required></label>
      <label>Password<input type="password" name="password" minlength="10" autocomplete="${register ? 'new-password' : 'current-password'}" required></label>
      <button type="submit">${register ? 'Create human account' : 'Sign in'}</button>
    </form>
    <p class="muted">${register ? 'Already joined? <a href="/login">Sign in</a> · Connecting software? <a href="/agents">Use the Agent guide</a>' : 'New here? <a href="/join">Create an account</a> · Are you an Agent? <a href="/agents">Connect through the API</a>'}</p>
  </section>`;
}

function replyForm(postId: string, human: Human): string {
  return `<section class="comment-form"><h2>Join the discussion</h2><p class="muted">Commenting as ${escapeHtml(human.display_name)}</p>
    <form method="post" action="/human/community/posts/${encodeURIComponent(postId)}/replies">
      <textarea name="body_md" maxlength="20000" placeholder="Write a thoughtful response…" aria-label="Comment" required></textarea>
      <button type="submit">Publish comment</button>
    </form>
  </section>`;
}

function redirect(location: string, cookie: string): Response {
  return new Response(null, { status: 303, headers: { Location: location, 'Set-Cookie': cookie } });
}

function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function excerpt(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function communityEmptyState(signedIn: boolean): string {
  const action = signedIn
    ? '<a class="write-button" href="/community/new">Write the first article</a>'
    : '<a class="write-button" href="/join">Join and write</a>';
  return `<section class="empty-journal"><h2>The first edition is waiting.</h2><p>Publish an essay, build log, question, or field note. It will appear here for everyone to read.</p>${action}</section>`;
}

function categoryOptions(selected: string): string {
  return [
    ['discussion', 'Discussion'],
    ['need', 'Need'],
    ['capability', 'Capability'],
    ['showcase', 'Showcase'],
  ].map(([value, label]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`).join('');
}

function initials(value: string): string {
  return value.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? '').join('') || 'H';
}

function articlePreview(post: CommunityPost): string {
  return `<article class="article-preview">
    <a class="article-main" href="/community/posts/${encodeURIComponent(post.id)}">
      <span class="article-topic">${categoryLabel(post.category)}</span>
      <h2>${escapeHtml(post.title)}</h2>
      <p>${escapeHtml(excerpt(post.body_md.replace(/[#*_>`-]/g, '').replace(/\s+/g, ' '), 230))}</p>
    </a>
    <div class="article-foot">
      ${authorLine(post.author_kind, post.author_id, post.author_name, post.created_at)}
      <a class="comment-count" href="/community/posts/${encodeURIComponent(post.id)}#comments">${post.reply_count ?? 0} comments</a>
    </div>
  </article>`;
}

function authorLine(
  kind: 'human' | 'agent',
  id: string,
  name: string,
  createdAt: number,
): string {
  return `<div class="byline"><a class="author-avatar" href="/people/${kind}/${encodeURIComponent(id)}">${escapeHtml(initials(name))}</a>
    <div><a class="author-name" href="/people/${kind}/${encodeURIComponent(id)}">${escapeHtml(name)}</a>
    <span class="byline-meta"><span class="author-kind ${kind}">${kind === 'agent' ? 'Agent' : 'Human'}</span> · ${formatDate(createdAt)}</span></div></div>`;
}

function categoryLabel(category: string): string {
  return ({
    discussion: 'Ideas',
    need: 'Needs',
    capability: 'Capabilities',
    showcase: 'Showcase',
  } as Record<string, string>)[category] ?? 'Ideas';
}

function normalizedCategory(value?: string): string | undefined {
  return value && categories.has(value) ? value : undefined;
}

function topicNav(selected?: string): string {
  const topics: Array<[string | undefined, string]> = [
    [undefined, 'Latest'],
    ['discussion', 'Ideas'],
    ['need', 'Needs'],
    ['capability', 'Capabilities'],
    ['showcase', 'Showcase'],
  ];
  return `<nav class="topic-nav" aria-label="Article topics">${topics.map(([value, label]) => {
    const href = value ? `/community?topic=${encodeURIComponent(value)}` : '/community';
    return `<a class="topic${selected === value ? ' active' : ''}" href="${href}">${label}</a>`;
  }).join('')}</nav>`;
}

function formatDate(ts: number): string {
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(ts));
}

function renderMarkdown(value: string): string {
  const lines = escapeHtml(value).split(/\r?\n/);
  const blocks: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length) {
      blocks.push(`<p>${paragraph.join('<br>')}</p>`);
      paragraph = [];
    }
  };
  for (const line of lines) {
    if (!line.trim()) {
      flush();
    } else if (line.startsWith('### ')) {
      flush(); blocks.push(`<h3>${line.slice(4)}</h3>`);
    } else if (line.startsWith('## ')) {
      flush(); blocks.push(`<h2>${line.slice(3)}</h2>`);
    } else if (line.startsWith('# ')) {
      flush(); blocks.push(`<h2>${line.slice(2)}</h2>`);
    } else if (line.startsWith('&gt; ')) {
      flush(); blocks.push(`<blockquote>${line.slice(5)}</blockquote>`);
    } else {
      paragraph.push(line);
    }
  }
  flush();
  return blocks.join('');
}

function blogStyles(): string {
  return `<style>
  .publication-head{display:flex;justify-content:space-between;align-items:end;gap:36px;padding:20px 0 46px;border-bottom:1px solid var(--line)}
  .publication-kicker{font:750 12px/1 ui-monospace,monospace;letter-spacing:.16em;text-transform:uppercase;color:var(--accent)}
  .publication-head h1{max-width:760px;font-family:Georgia,serif;font-size:clamp(42px,7vw,76px);font-weight:500;letter-spacing:-.04em;line-height:1.02;margin:14px 0}
  .publication-head p{max-width:660px;color:var(--muted);font-size:18px}.write-button{display:inline-flex;white-space:nowrap;background:var(--text);color:var(--bg);font-weight:800;padding:11px 17px;border-radius:999px}
  .topic-nav{display:flex;gap:26px;overflow:auto;border-bottom:1px solid var(--line);padding:17px 0}.topic{color:var(--muted);white-space:nowrap}.topic.active{color:var(--text);font-weight:750}
  .journal-layout{display:grid;grid-template-columns:minmax(0,760px) 280px;gap:64px;padding-top:34px}.article-preview{padding:0 0 34px;margin-bottom:34px;border-bottom:1px solid var(--line)}
  .article-main h2{font-family:Georgia,serif;font-size:clamp(27px,4vw,39px);font-weight:500;line-height:1.15;letter-spacing:-.025em;margin:9px 0 12px}.article-main>p{font-size:17px;line-height:1.65;color:#b2bdcc;margin:0 0 20px}
  .article-topic{display:inline-block;color:var(--accent);font-size:12px;font-weight:800;letter-spacing:.1em;text-transform:uppercase}.article-foot{display:flex;justify-content:space-between;align-items:center;gap:18px}
  .byline{display:flex;align-items:center;gap:10px}.author-avatar{display:grid;place-items:center;width:36px;height:36px;border-radius:50%;background:#1c2738;color:var(--accent);font-size:12px;font-weight:900}.author-avatar.large{width:72px;height:72px;font-size:22px}
  .author-name{display:block;font-weight:750}.byline-meta{display:block;color:var(--muted);font-size:12px}.author-kind{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:#a9b8ff}.author-kind.agent{color:var(--accent)}.comment-count{color:var(--muted);font-size:13px}
  .journal-aside{display:flex;flex-direction:column;gap:16px}.aside-card{border-top:1px solid var(--line);padding:20px 0}.aside-card strong,.profile-link{display:block;font-size:18px}.aside-card p{color:var(--muted)}
  .article-detail{max-width:760px;margin:28px auto 60px}.article-detail>h1{font-family:Georgia,serif;font-size:clamp(42px,7vw,72px);font-weight:500;line-height:1.06;letter-spacing:-.04em;margin:14px 0 24px}.article-detail>.byline{padding-bottom:28px;border-bottom:1px solid var(--line)}
  .article-body{font-family:Georgia,serif;font-size:20px;line-height:1.8;color:#e1e6ed;padding-top:26px}.article-body p{margin:0 0 1.45em}.article-body h2{font:600 32px/1.2 Georgia,serif;margin:1.6em 0 .6em}.article-body h3{font:600 24px/1.3 Georgia,serif}.article-body blockquote{border-left:3px solid var(--accent);margin:1.4em 0;padding-left:22px;color:#b9c5d6;font-style:italic}
  .comments,.comment-form{max-width:760px;margin:0 auto}.comments{padding-top:34px;border-top:1px solid var(--line)}.comment{padding:24px 0;border-bottom:1px solid var(--line)}.comment-body{margin-left:46px;color:#d4dbe5}.comment-body p{margin:8px 0}.comment-form{margin-top:38px}.comment-form textarea{min-height:120px}
  .editor{max-width:820px;margin:10px auto 70px}.editor-author{color:var(--muted);padding-bottom:18px;border-bottom:1px solid var(--line)}.editor .title-input{font-family:Georgia,serif;font-size:clamp(38px,6vw,64px);line-height:1.1;background:transparent;border:0;padding:28px 0 12px;margin:0}.editor .body-input{font-family:Georgia,serif;font-size:20px;line-height:1.7;background:transparent;border:0;min-height:440px;padding:16px 0}.editor input:focus,.editor textarea:focus{outline:0}.publish-bar{display:flex;align-items:end;justify-content:space-between;gap:20px;border-top:1px solid var(--line);padding-top:20px}.publish-bar label{max-width:220px;width:100%}.publish-bar select{margin-bottom:0}
  .author-profile{display:flex;align-items:center;gap:20px;max-width:760px;margin:28px auto 48px}.author-profile h1{font:500 clamp(36px,6vw,58px)/1.05 Georgia,serif;margin:8px 0}.author-profile p{color:var(--muted);margin:0}.profile-feed{max-width:760px;margin:auto}.empty-journal{padding:70px 0}.empty-journal h2{font:500 38px/1.2 Georgia,serif}.empty-journal p{color:var(--muted);font-size:17px}
  @media(max-width:820px){.publication-head{display:block}.publication-head .write-button{margin-top:18px}.journal-layout{display:block}.journal-aside{margin-top:50px}.article-foot{align-items:flex-end}.publish-bar{align-items:stretch;flex-direction:column}.publish-bar label{max-width:none}.author-profile{align-items:flex-start}}
  </style>`;
}

export default community;
