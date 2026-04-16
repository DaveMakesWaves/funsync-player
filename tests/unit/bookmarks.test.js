import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EditableScript } from '../../renderer/js/editable-script.js';

describe('EditableScript — bookmarks', () => {
  let script;

  beforeEach(() => {
    script = new EditableScript();
  });

  describe('addBookmark', () => {
    it('adds a bookmark', () => {
      script.addBookmark(5000, 'Test Mark');
      const bookmarks = script.getBookmarks();
      expect(bookmarks.length).toBe(1);
      expect(bookmarks[0]).toEqual({ at: 5000, name: 'Test Mark' });
    });

    it('maintains sort order', () => {
      script.addBookmark(5000, 'B');
      script.addBookmark(2000, 'A');
      script.addBookmark(8000, 'C');
      const bookmarks = script.getBookmarks();
      expect(bookmarks.map(b => b.at)).toEqual([2000, 5000, 8000]);
    });

    it('overwrites existing bookmark at same time', () => {
      script.addBookmark(5000, 'Old');
      script.addBookmark(5000, 'New');
      const bookmarks = script.getBookmarks();
      expect(bookmarks.length).toBe(1);
      expect(bookmarks[0].name).toBe('New');
    });

    it('rounds timestamp', () => {
      script.addBookmark(5000.7, 'Test');
      expect(script.getBookmarks()[0].at).toBe(5001);
    });

    it('defaults name to empty string', () => {
      script.addBookmark(5000);
      expect(script.getBookmarks()[0].name).toBe('');
    });

    it('marks dirty', () => {
      expect(script.dirty).toBe(false);
      script.addBookmark(5000, 'Test');
      expect(script.dirty).toBe(true);
    });

    it('is undoable', () => {
      script.addBookmark(5000, 'Test');
      expect(script.getBookmarks().length).toBe(1);
      script.undo();
      expect(script.getBookmarks().length).toBe(0);
    });

    it('fires onChange', () => {
      const cb = vi.fn();
      script.onChange = cb;
      script.addBookmark(5000, 'Test');
      expect(cb).toHaveBeenCalledTimes(1);
    });
  });

  describe('removeBookmark', () => {
    beforeEach(() => {
      script.addBookmark(2000, 'A');
      script.addBookmark(5000, 'B');
      script.addBookmark(8000, 'C');
      script.markSaved();
    });

    it('removes a bookmark', () => {
      const removed = script.removeBookmark(5000);
      expect(removed).toBe(true);
      expect(script.getBookmarks().length).toBe(2);
      expect(script.getBookmarks().find(b => b.at === 5000)).toBeUndefined();
    });

    it('returns false if bookmark not found', () => {
      const removed = script.removeBookmark(9999);
      expect(removed).toBe(false);
    });

    it('marks dirty', () => {
      script.removeBookmark(5000);
      expect(script.dirty).toBe(true);
    });

    it('is undoable', () => {
      script.removeBookmark(5000);
      expect(script.getBookmarks().length).toBe(2);
      script.undo();
      expect(script.getBookmarks().length).toBe(3);
      expect(script.getBookmarks().find(b => b.at === 5000)).toBeTruthy();
    });
  });

  describe('getBookmarks', () => {
    it('returns empty array by default', () => {
      expect(script.getBookmarks()).toEqual([]);
    });

    it('returns a copy (not a reference)', () => {
      script.addBookmark(5000, 'Test');
      const b1 = script.getBookmarks();
      b1[0].name = 'Mutated';
      expect(script.getBookmarks()[0].name).toBe('Test');
    });
  });

  describe('bookmarks in serialization', () => {
    it('includes bookmarks in toFunscriptJSON', () => {
      script.insertAction(1000, 50);
      script.addBookmark(500, 'Mark A');
      script.addBookmark(1500, 'Mark B');
      const json = JSON.parse(script.toFunscriptJSON());
      expect(json.metadata.bookmarks).toEqual([
        { at: 500, name: 'Mark A' },
        { at: 1500, name: 'Mark B' },
      ]);
    });

    it('omits bookmarks field when no bookmarks', () => {
      script.insertAction(1000, 50);
      const json = JSON.parse(script.toFunscriptJSON());
      expect(json.metadata).toBeUndefined();
    });
  });

  describe('bookmarks loaded from metadata', () => {
    it('loads bookmarks from funscript metadata', () => {
      script.loadMetadata({
        version: '1.0',
        metadata: {
          title: 'Test',
          bookmarks: [
            { at: 3000, name: 'Scene 2' },
            { at: 1000, name: 'Scene 1' },
          ],
        },
      });
      const bookmarks = script.getBookmarks();
      expect(bookmarks.length).toBe(2);
      expect(bookmarks[0].at).toBe(1000);
      expect(bookmarks[1].at).toBe(3000);
    });

    it('filters invalid bookmarks', () => {
      script.loadMetadata({
        metadata: {
          bookmarks: [
            { at: 1000, name: 'Valid' },
            { name: 'No time' },
            null,
            { at: 2000 },
          ],
        },
      });
      const bookmarks = script.getBookmarks();
      expect(bookmarks.length).toBe(2);
      expect(bookmarks[1].name).toBe('');
    });
  });

  describe('clear and loadEmpty reset bookmarks', () => {
    it('clear resets bookmarks', () => {
      script.addBookmark(5000, 'Test');
      script.clear();
      expect(script.getBookmarks()).toEqual([]);
    });

    it('loadEmpty resets bookmarks', () => {
      script.addBookmark(5000, 'Test');
      script.loadEmpty();
      expect(script.getBookmarks()).toEqual([]);
    });
  });
});
