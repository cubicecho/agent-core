import { describe, expect, it } from 'vitest';
import {
  artifactSource,
  declaredArtifact,
  detectArtifact,
  mediaTypeFor,
  RunArtifacts,
} from '../../src/run/artifacts.ts';

const at = (callId: string, tool = 'fs__write_file', step = 0) => ({ callId, tool, step });

describe('detectArtifact', () => {
  it('reads a write verb and a path as a created file, sized by its content', () => {
    expect(detectArtifact('fs__write_file', { path: '/a/b.md', content: 'héllo' })).toEqual({
      location: '/a/b.md',
      source: 'detected',
      action: 'created',
      mediaType: 'text/markdown',
      sizeBytes: 6,
    });
  });

  it('reads an edit as an update, a move as a move to its destination, and a delete as a delete', () => {
    expect(detectArtifact('fs__edit_file', { path: 'x.ts' })?.action).toBe('updated');
    expect(detectArtifact('fs__move_file', { source: 'a', destination: 'b' })).toMatchObject({
      location: 'b',
      action: 'moved',
    });
    expect(detectArtifact('delete_file', { path: 'gone.txt' })?.action).toBe('deleted');
  });

  it('makes nothing of a read, a folder, or a write with no location', () => {
    expect(detectArtifact('fs__read_file', { path: 'a' })).toBeNull();
    expect(detectArtifact('fs__create_directory', { path: 'a' })).toBeNull();
    expect(detectArtifact('fs__write_file', { content: 'a' })).toBeNull();
    expect(detectArtifact('fs__write_file', { path: '  ' })).toBeNull();
    expect(detectArtifact('fs__overwrite_file', { path: 'a' })).toBeNull();
  });
});

describe('declaredArtifact', () => {
  it('keeps what the model said, trimmed, and guesses the media type where it said none', () => {
    expect(declaredArtifact({ location: ' s3://b/k.png ', title: 'Chart' })).toEqual({
      location: 's3://b/k.png',
      source: 'declared',
      action: 'created',
      title: 'Chart',
      mediaType: 'image/png',
    });
    expect(declaredArtifact({ location: 'x', mediaType: 'text/plain' })?.mediaType).toBe('text/plain');
  });

  it('is nothing without a location', () => {
    expect(declaredArtifact({ title: 'Nowhere' })).toBeNull();
    expect(declaredArtifact({ location: 3 })).toBeNull();
  });
});

describe('mediaTypeFor', () => {
  it('guesses off the extension only', () => {
    expect(mediaTypeFor('https://x/y/report.PDF?v=1')).toBe('application/pdf');
    expect(mediaTypeFor('/a/.env')).toBeNull();
    expect(mediaTypeFor('/a/Makefile')).toBeNull();
    expect(mediaTypeFor('/a/b.unknown')).toBeNull();
  });
});

describe('RunArtifacts', () => {
  it('keeps one per location, the declaration’s words and the last write’s action and size', () => {
    const log = new RunArtifacts();
    const write = detectArtifact('fs__write_file', { path: 'p.md', content: 'one' });
    const declared = declaredArtifact({ location: 'p.md', title: 'Plan', description: 'The plan.' });
    const edit = detectArtifact('fs__edit_file', { path: 'p.md', content: 'three' });
    expect(write && log.add(write, at('c0'))).toBeDefined();
    expect(declared && log.add(declared, at('c1', 'record_artifact'))).toBeUndefined();
    expect(edit && log.add(edit, at('c2', 'fs__edit_file'))).toBeUndefined();
    expect(log.list()).toEqual([
      {
        link: { uri: 'p.md', name: 'p.md', title: 'Plan', description: 'The plan.', mimeType: 'text/markdown' },
        callId: 'c0',
        tool: 'fs__write_file',
        step: 0,
        count: 2,
        source: 'declared',
        action: 'updated',
        sizeBytes: 5,
      },
    ]);
  });

  it('lets a link take over a guess, keeping only what the link left unsaid', () => {
    const log = new RunArtifacts();
    const declared = declaredArtifact({ location: 'doc://a', title: 'Mine', description: 'Said.' });
    if (declared) {
      log.add(declared, at('c0'));
    }
    expect(log.link([{ uri: 'doc://a', name: 'a', title: 'Server' }], at('c1'))).toEqual([]);
    const [artifact] = log.list();
    expect(artifactSource(artifact)).toBe('linked');
    expect(artifact.link).toEqual({ uri: 'doc://a', name: 'a', title: 'Server', description: 'Said.' });
    expect(artifact.count).toBe(2);
  });

  it('lets a declaration fill only what a link left out, and stay a link', () => {
    const log = new RunArtifacts();
    log.link([{ uri: 'doc://a', name: 'a', title: 'Server' }], at('c0'));
    const declared = declaredArtifact({ location: 'doc://a', title: 'Mine', description: 'Said.' });
    if (declared) {
      log.add(declared, at('c0'));
    }
    const [artifact] = log.list();
    expect(artifact.source).toBeUndefined();
    expect(artifact.link).toMatchObject({ title: 'Server', description: 'Said.' });
    expect(artifact.count).toBe(1);
  });

  it('counts a call that both links and writes one location once', () => {
    const log = new RunArtifacts();
    log.link([{ uri: 'a.md', name: 'a.md' }], at('c0'));
    const write = detectArtifact('fs__write_file', { path: 'a.md' });
    if (write) {
      log.add(write, at('c0'));
      log.add(write, at('c0', 'fs__write_file', 1));
    }
    expect(log.list().map(({ count, action }) => ({ count, action }))).toEqual([{ count: 2, action: 'created' }]);
  });

  it('lands a declaration on the location it names bare, rather than beside it', () => {
    const log = new RunArtifacts();
    const write = detectArtifact('fs__write_file', { path: 'work/plan.md' });
    const declared = declaredArtifact({ location: 'file:///work/plan.md', title: 'Plan' });
    if (write && declared) {
      log.add(write, at('c0'));
      log.add(declared, at('c0'));
    }
    expect(log.list().map(({ link, source }) => ({ uri: link.uri, title: link.title, source }))).toEqual([
      { uri: 'work/plan.md', title: 'Plan', source: 'declared' },
    ]);
  });

  it('believes a location only where a call in the run was given or answered with it', () => {
    const log = new RunArtifacts();
    expect(log.seen('/work/plan.md')).toBeUndefined();
    log.witness({ path: 'work/plan.md', content: '# Plan' }, 'Wrote 6 bytes.', [], at('c0'));
    expect(log.seen('/work/plan.md')).toEqual(at('c0'));
    expect(log.seen('file:///work/plan.md')).toEqual(at('c0'));
    expect(log.seen('fs:///quinton_lucas_summary.md')).toBeUndefined();
    log.witness({ bucket: 'b' }, '{"url":"https://cdn.example.com/x/report.pdf"}', [], at('c1', 'upload'));
    expect(log.seen('https://cdn.example.com/x/report.pdf')).toEqual(at('c1', 'upload'));
    log.witness({}, 'ok', [{ uri: 'doc://linked', name: 'l' }], at('c2', 'save'));
    expect(log.seen('doc://linked')).toEqual(at('c2', 'save'));
    expect(log.seen('  ')).toBeUndefined();
  });

  it('puts a declaration down to the latest call that touched its location', () => {
    const log = new RunArtifacts();
    log.witness({ path: 'a.md' }, 'read', [], at('c0', 'read_file'));
    log.witness({ path: 'a.md', content: 'x' }, 'wrote', [], at('c1', 'write_file'));
    expect(log.seen('a.md')).toEqual(at('c1', 'write_file'));
  });
});
