import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EditableScript } from '../../renderer/js/editable-script.js';

describe('EditableScript — metadata', () => {
  let script;

  beforeEach(() => {
    script = new EditableScript();
  });

  describe('loadMetadata', () => {
    it('stores metadata without actions', () => {
      script.loadMetadata({ version: '1.0', inverted: false, range: 100, actions: [{ at: 0, pos: 0 }] });
      const meta = script.getMetadata();
      expect(meta.version).toBe('1.0');
      expect(meta.actions).toBeUndefined();
    });

    it('deep clones metadata', () => {
      const source = { version: '1.0', metadata: { title: 'Test' } };
      script.loadMetadata(source);
      source.metadata.title = 'Changed';
      expect(script.getMetadata().metadata.title).toBe('Test');
    });

    it('extracts bookmarks from metadata.metadata.bookmarks', () => {
      script.loadMetadata({
        version: '1.0',
        metadata: {
          bookmarks: [
            { at: 5000, name: 'Mark A' },
            { at: 2000, name: 'Mark B' },
          ],
        },
      });
      const bookmarks = script.getBookmarks();
      expect(bookmarks.length).toBe(2);
      // Should be sorted
      expect(bookmarks[0].at).toBe(2000);
      expect(bookmarks[1].at).toBe(5000);
    });
  });

  describe('getMetadata', () => {
    it('returns empty object by default', () => {
      expect(script.getMetadata()).toEqual({});
    });

    it('returns a copy (not a reference)', () => {
      script.loadMetadata({ version: '1.0', metadata: { title: 'Test' } });
      const meta1 = script.getMetadata();
      meta1.metadata.title = 'Mutated';
      expect(script.getMetadata().metadata.title).toBe('Test');
    });
  });

  describe('setMetadataField', () => {
    it('sets a field under metadata.metadata', () => {
      script.setMetadataField('title', 'My Script');
      const meta = script.getMetadata();
      expect(meta.metadata.title).toBe('My Script');
    });

    it('creates metadata sub-object if missing', () => {
      expect(script.getMetadata().metadata).toBeUndefined();
      script.setMetadataField('creator', 'user');
      expect(script.getMetadata().metadata.creator).toBe('user');
    });

    it('marks dirty', () => {
      expect(script.dirty).toBe(false);
      script.setMetadataField('title', 'Test');
      expect(script.dirty).toBe(true);
    });

    it('is undoable', () => {
      script.setMetadataField('title', 'First');
      script.setMetadataField('title', 'Second');
      expect(script.getMetadata().metadata.title).toBe('Second');
      script.undo();
      expect(script.getMetadata().metadata.title).toBe('First');
    });

    it('fires onChange', () => {
      const cb = vi.fn();
      script.onChange = cb;
      script.setMetadataField('title', 'Test');
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe('toFunscriptJSON with metadata', () => {
    it('uses internal metadata by default', () => {
      script.loadMetadata({ version: '2.0', inverted: true });
      script.insertAction(1000, 50);
      const json = JSON.parse(script.toFunscriptJSON());
      expect(json.version).toBe('2.0');
      expect(json.inverted).toBe(true);
      expect(json.actions.length).toBe(1);
    });

    it('uses override metadata when provided', () => {
      script.loadMetadata({ version: '1.0' });
      script.insertAction(1000, 50);
      const json = JSON.parse(script.toFunscriptJSON({ version: '3.0' }));
      expect(json.version).toBe('3.0');
    });
  });

  describe('loadFromEngine preserves metadata', () => {
    it('loads metadata from engine', () => {
      const mockEngine = {
        getActions: () => [{ at: 100, pos: 50 }],
        getMetadata: () => ({ version: '1.0', metadata: { title: 'From Engine' } }),
      };
      script.loadFromEngine(mockEngine);
      expect(script.getMetadata().metadata.title).toBe('From Engine');
    });

    it('handles null metadata from engine', () => {
      const mockEngine = {
        getActions: () => [{ at: 100, pos: 50 }],
        getMetadata: () => null,
      };
      script.loadFromEngine(mockEngine);
      expect(script.getMetadata()).toEqual({});
    });
  });
});
