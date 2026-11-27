// The post helpers (renderer/js/eroscripts-post.js) for the EroScripts tab's
// download window: the review's 2.1-2.5, 2026-11-23. jsdom: the sanitiser
// builds DOM.
import { describe, it, expect } from 'vitest';
import {
  sanitizePostHtml, postPlainText, postUrl, emojiText, statedDuration, lengthVerdict, isLengthWarning,
  scriptSummary, provenance, sizesDiffer, buildScriptChoices, MAX_POST_IMAGES,
} from '../../renderer/js/eroscripts-post.js';
import { scriptChoices } from '../../renderer/components/eroscripts-view.js';

const html = (frag) => { const d = document.createElement('div'); d.appendChild(frag); return d; };

describe('2.1 the post, sanitised', () => {
  it('keeps text and plain formatting; drops scripts, styles, handlers, forms and every attribute', () => {
    const d = html(sanitizePostHtml('<h2 id="x">Notes</h2><p class="c" style="color:red" onclick="steal()">Hi <b>all</b><br>line</p>'
      + '<script>window.__bad = 1</script><style>p{}</style><form action="/x"><input value="k"></form><ul><li>one</li></ul>'
      + '<p><img src="x" onerror="window.__bad = 2"></p>'));
    expect(d.textContent).toBe('NotesHi allline' + 'one');
    expect(d.querySelector('script, style, form, input')).toBeNull();
    expect(d.innerHTML).not.toMatch(/onclick|onerror|style=|class="c"|id="x"/);
    expect(d.querySelector('p.es-post__h').textContent).toBe('Notes');
    expect(window.__bad).toBeUndefined();
  });

  it('links: http(s) only, forum-relative made absolute, marked to open outside; mentions and tags are text', () => {
    const d = html(sanitizePostHtml('<a href="https://pixeldrain.com/u/x">video</a> <a href="javascript:alert(1)">bad</a> <a href="/t/123">post</a>'
      + ' <a class="mention" href="/u/maker">@maker</a> <a class="hashtag" href="/tag/pmv">#pmv</a>'));
    const links = [...d.querySelectorAll('a')];
    expect(links.map((a) => a.dataset.href)).toEqual(['https://pixeldrain.com/u/x', 'https://discuss.eroscripts.com/t/123']);
    expect(d.textContent).toContain('bad');
    expect(d.textContent).toContain('@maker');
    expect(d.textContent).toContain('#pmv');
    expect(links.every((a) => a.classList.contains('es-post__link'))).toBe(true);
  });

  it('images become slots (forum or not, with their shape); lightbox info, avatars dropped; emoji as their text; embeds as links', () => {
    const d = html(sanitizePostHtml(
      '<div class="lightbox-wrapper"><a class="lightbox" href="/uploads/full.png"><img src="/uploads/opt.png" width="400" height="200" alt="preview"><div class="meta">opt.png 400×200 12 KB</div></a></div>'
      + '<img src="//i.imgur.com/a.gif"><img class="avatar" src="/user_avatar/a.png"><img class="emoji" alt=":fire:" src="/e.png">'
      + '<iframe src="https://erosync.net/embed/abc"></iframe>'));
    const slots = [...d.querySelectorAll('.es-post__img')];
    expect(slots.map((s) => [s.dataset.src, s.dataset.forum])).toEqual([
      ['https://discuss.eroscripts.com/uploads/opt.png', '1'],
      ['https://i.imgur.com/a.gif', '0'],
    ]);
    expect(slots[0].style.aspectRatio).toBe('400 / 200');
    expect(d.textContent).not.toContain('12 KB');
    expect(d.textContent).toContain('🔥');
    expect(d.querySelector('iframe')).toBeNull();
    expect(d.querySelector('a[data-href="https://erosync.net/embed/abc"]')).toBeTruthy();
  });

  it('quotes say whose they are; a link preview is one link; at most MAX_POST_IMAGES images', () => {
    const d = html(sanitizePostHtml('<aside class="quote" data-username="fan"><div class="title"><img class="avatar" src="/a.png"> fan:</div><blockquote><p>is it synced?</p></blockquote></aside>'
      + '<aside class="onebox" data-onebox-src="https://faptap.net/v/1"><header><a href="https://faptap.net">faptap</a></header><h3><a href="https://faptap.net/v/1">The video</a></h3><p>long text</p></aside>'
      + '<img src="/u/i.png">'.repeat(MAX_POST_IMAGES + 5)));
    expect(d.querySelector('.es-post__quote').textContent).toBe('@fanis it synced?');
    const onebox = d.querySelector('a[data-href="https://faptap.net/v/1"]');
    expect(onebox.textContent).toBe('The video');
    expect(d.textContent).not.toContain('long text');
    expect(d.querySelectorAll('.es-post__img').length).toBe(MAX_POST_IMAGES);
  });

  it('emoji shortcodes as characters (clock faces, skin tones); an unknown one is left out, never ":name:"', () => {
    expect([':fire:', ':clock1:', ':clock12:', ':clock130:', ':clock1230:', ':thumbsup:t2:', ':+1:'].map(emojiText))
      .toEqual(['🔥', '🕐', '🕛', '🕜', '🕧', '👍', '👍']);
    expect(emojiText(':some_custom_one:')).toBe('');
  });

  it('postUrl and postPlainText', () => {
    expect(postUrl('data:image/png;base64,AA')).toBeNull();
    expect(postUrl('//cdn.x/a.png')).toBe('https://cdn.x/a.png');
    expect(postPlainText('<p>Duration: <b>12:30</b></p><aside class="quote"><p>Length: 1:00</p></aside>')).toBe('Duration: 12:30');
  });
});

describe('2.3 lengths', () => {
  it('a LABELLED length, as a clock or in minutes (only minutes is approximate); a bare time is not a length', () => {
    expect(statedDuration('Duration: 43:16')).toEqual({ seconds: 2596, approx: false });
    expect(statedDuration('video length - 1:02:03 enjoy')).toEqual({ seconds: 3723, approx: false });
    expect(statedDuration('Runtime: 25 min')).toEqual({ seconds: 1500, approx: true });
    expect(statedDuration('Length 12m 34s')).toEqual({ seconds: 754, approx: false });
    expect(statedDuration('posted at 12:30, see 3:45 for the good part')).toBeNull();
    expect(statedDuration('Length: 12:75')).toBeNull();
    expect(statedDuration('')).toBeNull();
  });

  it('the verdicts: past the end, another recorded length, much longer, a match, fits; unknown is no verdict', () => {
    expect(lengthVerdict({ scriptEndS: 130, videoS: 100 })).toMatchObject({ kind: 'pastEnd', gapS: 30 });
    expect(lengthVerdict({ scriptEndS: 90, metaS: 2596, videoS: 2462 })).toMatchObject({ kind: 'length' });
    expect(lengthVerdict({ scriptEndS: 90, metaS: 2596000, videoS: 2597 })).toMatchObject({ kind: 'match' }); // ms recorded
    expect(lengthVerdict({ scriptEndS: 600, videoS: 1800 })).toMatchObject({ kind: 'muchLonger', gapS: 1200 });
    expect(lengthVerdict({ scriptEndS: 1700, videoS: 1800 })).toMatchObject({ kind: 'fits' });
    expect(lengthVerdict({ scriptEndS: 1530, videoS: 1500, approx: true })).toMatchObject({ kind: 'fits' }); // "25 min" is ±1 min
    expect(lengthVerdict({ scriptEndS: 100, videoS: 0 })).toBeNull();
    expect(isLengthWarning({ kind: 'fits' })).toBe(false);
    expect(isLengthWarning({ kind: 'pastEnd' })).toBe(true);
  });
});

describe('2.2 what the script is like', () => {
  it('length, count, average over moves, fastest at the 98th percentile (one glitch is not "frantic")', () => {
    const calm = [];
    for (let i = 0; i <= 100; i++) calm.push({ at: i * 1000, pos: i % 2 ? 100 : 0 });   // 100 u/s
    calm.splice(50, 0, { at: 49_990, pos: 0 });                                         // one 10 ms glitch
    const s = scriptSummary(calm);
    expect(s.count).toBe(102);
    expect(s.lengthS).toBe(100);
    expect(s.maxSpeed).toBeLessThan(600);
    expect(s.fast).toBe(false);
    expect(scriptSummary([])).toEqual({ lengthS: 0, count: 0, avgSpeed: 0, maxSpeed: 0, fast: false });
  });
});

describe('2.4 / 2.5 who posted it', () => {
  it('provenance and sizes', () => {
    expect(provenance({ from: 'post' }, 'maker')).toBe('post');
    expect(provenance({ from: 'reply', username: 'MAKER' }, 'maker')).toBe('scripter');
    expect(provenance({ from: 'reply', username: 'x' }, 'maker')).toBe('other');
    expect(sizesDiffer(2900, 3282)).toBe(true);
    expect(sizesDiffer(3282, 3290)).toBe(false);
    expect(sizesDiffer(0, 3282)).toBe(false);
  });

  it('script choices: the post\'s first, then the replies\'; the scripter\'s newest whole script is chosen, never a lone axis file', () => {
    const U = (n) => `https://discuss.eroscripts.com/uploads/${n}`;
    const post = [{ name: 'A.funscript', url: U('a') }];
    const replies = [
      { name: 'A.roll.funscript', url: U('r'), postNumber: 9, username: 'maker', createdAt: 'x', likes: 0 },
      { name: 'A v2.funscript', url: U('v2'), postNumber: 5, username: 'maker', createdAt: 'x', likes: 1 },
      { name: 'Other.funscript', url: U('o'), postNumber: 4, username: 'fan', createdAt: 'x', likes: 0 },
    ];
    const { choices, index } = buildScriptChoices(post, replies, 'Maker', scriptChoices);
    expect(choices.map((c) => [c.name, c.from, c.postNumber ?? null])).toEqual([
      ['A.funscript', 'post', null], ['A.roll.funscript', 'reply', 9], ['A v2.funscript', 'reply', 5], ['Other.funscript', 'reply', 4],
    ]);
    expect(choices[index].name).toBe('A v2.funscript');
    expect(buildScriptChoices(post, replies.slice(2), 'maker', scriptChoices).index).toBe(0);
    expect(buildScriptChoices([], [], 'maker', scriptChoices)).toEqual({ choices: [], index: -1 });
  });
});
