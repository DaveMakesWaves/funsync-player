// SessionHistoryModal — read-only list of past external-controller sessions.
// Opens from the session card's clock icon. Shows source, identifier,
// duration, start time, and the videos played during each session.

import { Modal } from './modal.js';

const SOURCE_LABEL = {
  'web-remote': 'Web Remote',
  'vr':         'VR Companion',
};

/**
 * @param {import('../js/session-tracker.js').SessionTracker} tracker
 */
export async function openSessionHistory(tracker) {
  await Modal.open({
    title: 'Session History',
    onRender: (body, close) => {
      const entries = tracker.getHistory();

      if (entries.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'session-history__empty';
        empty.textContent = 'No sessions recorded yet. Connect a phone or VR headset to log one.';
        body.appendChild(empty);
        return;
      }

      const list = document.createElement('div');
      list.className = 'session-history__list';

      for (const entry of entries) {
        list.appendChild(renderEntry(entry));
      }
      body.appendChild(list);

      const footer = document.createElement('div');
      footer.className = 'session-history__footer';
      const count = document.createElement('span');
      count.className = 'session-history__count';
      count.textContent = `${entries.length} session${entries.length !== 1 ? 's' : ''}`;
      footer.appendChild(count);

      const clearBtn = document.createElement('button');
      clearBtn.className = 'session-history__clear';
      clearBtn.textContent = 'Clear history';
      clearBtn.addEventListener('click', async () => {
        const ok = await Modal.confirm('Clear session history', 'Delete all recorded sessions?');
        if (ok) {
          tracker.clearHistory();
          close();
        }
      });
      footer.appendChild(clearBtn);

      body.appendChild(footer);
    },
  });
}

function renderEntry(entry) {
  const item = document.createElement('div');
  item.className = 'session-history__item';

  const head = document.createElement('div');
  head.className = 'session-history__head';

  const src = document.createElement('span');
  src.className = 'session-history__source';
  src.textContent = SOURCE_LABEL[entry.source] || entry.source;
  head.appendChild(src);

  const id = document.createElement('span');
  id.className = 'session-history__id';
  id.textContent = entry.identifier || '';
  head.appendChild(id);

  const when = document.createElement('span');
  when.className = 'session-history__when';
  when.textContent = formatWhen(entry.startedAt);
  head.appendChild(when);

  item.appendChild(head);

  const durMs = (entry.endedAt || Date.now()) - entry.startedAt;
  const dur = document.createElement('div');
  dur.className = 'session-history__duration';
  dur.textContent = `Duration: ${formatDurationMs(durMs)}`;
  item.appendChild(dur);

  if (entry.videos && entry.videos.length > 0) {
    const vids = document.createElement('ul');
    vids.className = 'session-history__videos';
    for (const v of entry.videos) {
      const li = document.createElement('li');
      const vd = (v.endedAt || Date.now()) - v.startedAt;
      li.textContent = `${v.name} (${formatDurationMs(vd)})`;
      li.title = v.name;
      vids.appendChild(li);
    }
    item.appendChild(vids);
  }

  return item;
}

function formatWhen(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (sameDay) return `Today, ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;
  return `${d.toLocaleDateString()} ${time}`;
}

function formatDurationMs(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${ss}s`;
  return `${ss}s`;
}
