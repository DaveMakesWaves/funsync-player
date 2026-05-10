// Editor pop-out — entry point for the secondary BrowserWindow.
//
// Currently a placeholder: the IPC bridge is wired, lifecycle events
// flow, and the "Dock back" button works. Mounting the actual
// ScriptEditor + ActionGraph in here is the next implementation chunk.
// That work depends on:
//
//   - A video-time stub that proxies `currentTime` / `duration` via
//     `window.funsync.editorPopoutRelay('to-parent', { type: 'video-query', ... })`.
//   - State sync for actions / undo / save through the relay channel.
//   - A render of the existing editor-host DOM structure inside this
//     window's `#editor-popout-host`.
//
// See `notes/features/SCOPE-editor-v2.md` §4 for the full plan.

const dockBackBtn = document.getElementById('dock-back-btn');
if (dockBackBtn) {
  dockBackBtn.addEventListener('click', () => {
    // Triggers main process → main process closes the BrowserWindow →
    // `closed` listener fires → main window receives 'editor-popout:closed'
    // → main window's editor panel reappears. Single source of truth in
    // main process (no popout-side state to clean up).
    window.funsync.editorPopoutClose();
  });
}

// Echo lifecycle events to the console so dev-time observability works
// out of the box. Production code can ignore these.
window.funsync.onEditorPopoutEvent((event) => {
  if (event.type === 'message') {
    // Future: route to the editor instance running inside this window.
    // For now just log so the bridge is verifiable end-to-end.
    console.debug('[editor-popout] message from parent:', event.payload);
  } else {
    console.debug('[editor-popout] lifecycle event:', event.type);
  }
});

// Smoke test: ping main → broker → parent so the bridge's `to-parent`
// direction has at least one consumer in dev. Remove or repurpose when
// the real protocol lands.
window.funsync.editorPopoutRelay('to-parent', { type: 'popout-ready' });
