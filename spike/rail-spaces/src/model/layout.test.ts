import { describe, expect, test } from 'vitest';
import { Layout } from './layout';

const tower = 's-tower';
const swe = 's-swe';

function twoSpaces(): Layout {
  const layout = new Layout();
  layout.createSpace(tower, 'tower');
  layout.createSpace(swe, 'swe');
  return layout;
}

describe('where a conversation lives', () => {
  test('a placed conversation is placed in the space it was put in', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);

    const expected = tower;
    const actual = layout.spaceOf('c-alpha');

    expect(actual).toBe(expected);
  });

  test('an unplaced conversation is in no space', () => {
    const layout = twoSpaces();

    const expected = null;
    const actual = layout.spaceOf('c-alpha');

    expect(actual).toBe(expected);
  });

  test('placing a conversation takes it out of where it was', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.place('c-alpha', swe);

    const expected: string[] = [];
    const actual = layout.placedIn(tower);

    expect(actual).toEqual(expected);
  });

  test('a conversation placed twice is placed in the space it went to last', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.place('c-alpha', swe);

    const expected = swe;
    const actual = layout.spaceOf('c-alpha');

    expect(actual).toBe(expected);
  });

  test('taking a conversation out leaves it unplaced', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.unplace('c-alpha');

    const expected = null;
    const actual = layout.spaceOf('c-alpha');

    expect(actual).toBe(expected);
  });
});

describe('the filing gesture', () => {
  test('filing a conversation twice leaves it in the same space', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.place('c-alpha', tower);

    const expected = tower;
    const actual = layout.spaceOf('c-alpha');

    expect(actual).toBe(expected);
  });

  test('filing never takes a conversation out of a space', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.place('c-alpha', tower);

    const expected = ['c-alpha'];
    const actual = layout.placedIn(tower);

    expect(actual).toEqual(expected);
  });

  test('filing a conversation that is minimised leaves it minimised', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.minimise('c-alpha');
    layout.place('c-alpha', tower);

    const expected = ['c-alpha'];
    const actual = layout.minimisedIn(tower);

    expect(actual).toEqual(expected);
  });

  test('filing into a second space moves it there', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.place('c-alpha', swe);

    const expected = swe;
    const actual = layout.spaceOf('c-alpha');

    expect(actual).toBe(expected);
  });
});

describe('placement order', () => {
  test('a newly placed conversation goes last among the others', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.place('c-beta', tower);

    const expected = ['c-alpha', 'c-beta'];
    const actual = layout.placedIn(tower);

    expect(actual).toEqual(expected);
  });

  test('filing a conversation into the space it already sits in keeps its position', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.place('c-beta', tower);
    layout.place('c-alpha', tower);

    const expected = ['c-alpha', 'c-beta'];
    const actual = layout.placedIn(tower);

    expect(actual).toEqual(expected);
  });

  test('a conversation that leaves and comes back goes last', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.place('c-beta', tower);
    layout.place('c-alpha', swe);
    layout.place('c-alpha', tower);

    const expected = ['c-beta', 'c-alpha'];
    const actual = layout.placedIn(tower);

    expect(actual).toEqual(expected);
  });
});

describe('minimising a conversation', () => {
  test('a minimised conversation keeps its space', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.minimise('c-alpha');

    const expected = tower;
    const actual = layout.spaceOf('c-alpha');

    expect(actual).toBe(expected);
  });

  test('a minimised conversation is not drawn', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.minimise('c-alpha');

    const expected: string[] = [];
    const actual = layout.drawnIn(tower);

    expect(actual).toEqual(expected);
  });

  test('a space lists its own minimised conversations', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.minimise('c-alpha');

    const expected = ['c-alpha'];
    const actual = layout.minimisedIn(tower);

    expect(actual).toEqual(expected);
  });

  test('restoring a conversation draws it again', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.minimise('c-alpha');
    layout.restore('c-alpha');

    const expected = ['c-alpha'];
    const actual = layout.drawnIn(tower);

    expect(actual).toEqual(expected);
  });

  test('a conversation brought back comes back last, which is how a space is reordered', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.place('c-beta', tower);
    layout.minimise('c-alpha');
    layout.restore('c-alpha');

    const expected = ['c-beta', 'c-alpha'];
    const actual = layout.drawnIn(tower);

    expect(actual).toEqual(expected);
  });
});

describe('what is on the screen', () => {
  test('the space shown draws the conversations placed in it', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.place('c-beta', swe);
    layout.showSpace(tower);

    const expected = ['c-alpha'];
    const actual = layout.drawn;

    expect(actual).toEqual(expected);
  });

  test('showing no space draws nothing', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);

    const expected: string[] = [];
    const actual = layout.drawn;

    expect(actual).toEqual(expected);
  });

  test('a space whose conversations are all minimised draws nothing', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.minimise('c-alpha');
    layout.showSpace(tower);

    const expected: string[] = [];
    const actual = layout.drawn;

    expect(actual).toEqual(expected);
  });

  test('what streams is what is drawn', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.place('c-beta', tower);
    layout.showSpace(tower);

    const expected = ['c-alpha', 'c-beta'];
    const actual = layout.subscribed;

    expect(actual).toEqual(expected);
  });

  test('minimising a conversation stops it streaming', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.place('c-beta', tower);
    layout.showSpace(tower);
    layout.minimise('c-alpha');

    const expected = ['c-beta'];
    const actual = layout.subscribed;

    expect(actual).toEqual(expected);
  });
});

describe('going to a conversation', () => {
  test('going to a conversation shows the space it is placed in', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', swe);
    layout.showSpace(tower);
    layout.goTo('c-alpha');

    const expected = swe;
    const actual = layout.shownSpace;

    expect(actual).toBe(expected);
  });

  test('going to a conversation leaves it in the space it is placed in', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', swe);
    layout.place('c-beta', swe);
    layout.goTo('c-alpha');

    const expected = ['c-alpha', 'c-beta'];
    const actual = layout.placedIn(swe);

    expect(actual).toEqual(expected);
  });

  test('going to a minimised conversation draws it again', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', swe);
    layout.minimise('c-alpha');
    layout.goTo('c-alpha');

    const expected = ['c-alpha'];
    const actual = layout.drawn;

    expect(actual).toEqual(expected);
  });

  test('going to a conversation that is already drawn leaves the order alone', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', swe);
    layout.place('c-beta', swe);
    layout.goTo('c-alpha');

    const expected = ['c-alpha', 'c-beta'];
    const actual = layout.drawnIn(swe);

    expect(actual).toEqual(expected);
  });

  test('an unplaced conversation offers no space to show', () => {
    const layout = twoSpaces();

    const expected = false;
    const actual = layout.goTo('c-alpha');

    expect(actual).toBe(expected);
  });

  test('failing to go somewhere leaves the space shown as it was', () => {
    const layout = twoSpaces();
    layout.showSpace(tower);
    layout.goTo('c-alpha');

    const expected = tower;
    const actual = layout.shownSpace;

    expect(actual).toBe(expected);
  });
});

describe('the rail', () => {
  const register = ['c-alpha', 'c-beta', 'c-gamma'];

  test('the rail lists every conversation by default', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);

    const expected = register;
    const actual = layout.railRows(register);

    expect(actual).toEqual(expected);
  });

  test('scoped to this space, the rail lists only what is placed here', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.place('c-beta', swe);
    layout.showSpace(tower);
    layout.setScope('space');

    const expected = ['c-alpha'];
    const actual = layout.railRows(register);

    expect(actual).toEqual(expected);
  });

  test('scoped to this space while no space is shown, the rail lists nothing', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.setScope('space');

    const expected: string[] = [];
    const actual = layout.railRows(register);

    expect(actual).toEqual(expected);
  });

  test('scoped to unplaced, the rail lists only conversations with no placement', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);

    layout.setScope('unplaced');

    const expected = ['c-beta', 'c-gamma'];
    const actual = layout.railRows(register);

    expect(actual).toEqual(expected);
  });

  test('a conversation placed in a space leaves the unplaced list', () => {
    const layout = twoSpaces();
    layout.setScope('unplaced');
    layout.place('c-beta', tower);

    const expected = ['c-alpha', 'c-gamma'];
    const actual = layout.railRows(register);

    expect(actual).toEqual(expected);
  });

  test('a search by id finds a conversation the scope had hidden', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.showSpace(tower);
    layout.setScope('space');
    layout.setSearch('GAMMA');

    const expected = ['c-gamma'];
    const actual = layout.railRows(register);

    expect(actual).toEqual(expected);
  });

  test("a search by id finds a conversation the rail's own filters had hidden", () => {
    const layout = twoSpaces();
    layout.setSearch('gamma');

    const expected = ['c-gamma'];
    const actual = layout.railRows(register, ['c-alpha']);

    expect(actual).toEqual(expected);
  });

  test('the scope filters what the rail was already showing', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.place('c-beta', tower);
    layout.showSpace(tower);
    layout.setScope('space');

    const expected = ['c-beta'];
    const actual = layout.railRows(register, ['c-beta', 'c-gamma']);

    expect(actual).toEqual(expected);
  });
});

describe('the spaces themselves', () => {
  test('a fresh layout has no spaces at all', () => {
    const layout = new Layout();

    const expected: string[] = [];
    const actual = layout.spaces.map((s) => s.id);

    expect(actual).toEqual(expected);
  });

  test('a space keeps existing once the last conversation moves out', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.place('c-alpha', swe);

    const expected = [tower, swe];
    const actual = layout.spaces.map((s) => s.id);

    expect(actual).toEqual(expected);
  });

  test('a space holds other spaces', () => {
    const layout = twoSpaces();
    layout.createSpace('s-eagers', 'eagers', swe);

    const expected = ['s-eagers'];
    const actual = layout.children(swe).map((s) => s.id);

    expect(actual).toEqual(expected);
  });

  test('a space inside another does not sit at the top level', () => {
    const layout = twoSpaces();
    layout.createSpace('s-eagers', 'eagers', swe);

    const expected = [tower, swe];
    const actual = layout.children(null).map((s) => s.id);

    expect(actual).toEqual(expected);
  });

  test('a space held inside another keeps its own conversations to itself', () => {
    const layout = twoSpaces();
    layout.createSpace('s-eagers', 'eagers', swe);
    layout.place('c-alpha', 's-eagers');

    const expected: string[] = [];
    const actual = layout.placedIn(swe);

    expect(actual).toEqual(expected);
  });

  test('renaming a space leaves its conversations where they are', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.renameSpace(tower, 'tower-v2');

    const expected = [tower];
    const actual = [layout.spaceOf('c-alpha')];

    expect(actual).toEqual(expected);
  });
});

describe('deleting a space', () => {
  test('deleting a space releases the conversations in it', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.deleteSpace(tower);

    const expected = null;
    const actual = layout.spaceOf('c-alpha');

    expect(actual).toBe(expected);
  });

  test('deleting a space leaves conversations in other spaces alone', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.place('c-beta', swe);
    layout.deleteSpace(tower);

    const expected = swe;
    const actual = layout.spaceOf('c-beta');

    expect(actual).toBe(expected);
  });

  test('deleting a space takes the spaces held inside it with it', () => {
    const layout = twoSpaces();
    layout.createSpace('s-eagers', 'eagers', swe);
    layout.deleteSpace(swe);

    const expected = [tower];
    const actual = layout.spaces.map((s) => s.id);

    expect(actual).toEqual(expected);
  });

  test('deleting a space releases conversations held deeper inside it', () => {
    const layout = twoSpaces();
    layout.createSpace('s-eagers', 'eagers', swe);
    layout.place('c-alpha', 's-eagers');
    layout.deleteSpace(swe);

    const expected = null;
    const actual = layout.spaceOf('c-alpha');

    expect(actual).toBe(expected);
  });

  test('deleting the space being shown leaves no space shown', () => {
    const layout = twoSpaces();
    layout.showSpace(tower);
    layout.deleteSpace(tower);

    const expected = null;
    const actual = layout.shownSpace;

    expect(actual).toBe(expected);
  });
});

describe('the layout as it travels', () => {
  test('a layout handed over whole arrives with its conversations where they were', () => {
    const sender = twoSpaces();
    sender.place('c-alpha', tower);
    sender.place('c-beta', tower);
    sender.minimise('c-beta');
    sender.createSpace('s-eagers', 'eagers', swe);
    sender.place('c-gamma', 's-eagers');

    const expected = sender.snapshot();
    const actual = new Layout(expected).snapshot();

    expect(actual).toEqual(expected);
  });

  test('a layout handed over whole keeps which conversations are drawn', () => {
    const sender = twoSpaces();
    sender.place('c-alpha', tower);
    sender.place('c-beta', tower);
    sender.minimise('c-beta');

    const expected = ['c-alpha'];
    const actual = new Layout(sender.snapshot()).drawnIn(tower);

    expect(actual).toEqual(expected);
  });

  test('a layout handed over whole keeps placement order', () => {
    const sender = twoSpaces();
    sender.place('c-beta', tower);
    sender.place('c-alpha', tower);

    const expected = ['c-beta', 'c-alpha'];
    const actual = new Layout(sender.snapshot()).placedIn(tower);

    expect(actual).toEqual(expected);
  });

  test('what a client sends carries nothing about which space it is showing', () => {
    const layout = twoSpaces();
    layout.showSpace(tower);
    layout.setScope('unplaced');

    const expected = ['spaces', 'placements'];
    const actual = Object.keys(layout.snapshot());

    expect(actual).toEqual(expected);
  });

  test('a placement naming a space that did not arrive is dropped', () => {
    const layout = new Layout({
      spaces: [{ id: tower, name: 'tower', parent: null }],
      placements: [{ conv: 'c-alpha', space: 's-gone', drawn: true }],
    });

    const expected = null;
    const actual = layout.spaceOf('c-alpha');

    expect(actual).toBe(expected);
  });

  test('a space naming a parent that did not arrive stands at the top level', () => {
    const layout = new Layout({
      spaces: [{ id: swe, name: 'swe', parent: 's-gone' }],
      placements: [],
    });

    const expected = [swe];
    const actual = layout.children(null).map((s) => s.id);

    expect(actual).toEqual(expected);
  });

  test('a conversation named twice in one layout lives in the space named last', () => {
    const layout = new Layout({
      spaces: [
        { id: tower, name: 'tower', parent: null },
        { id: swe, name: 'swe', parent: null },
      ],
      placements: [
        { conv: 'c-alpha', space: tower, drawn: true },
        { conv: 'c-alpha', space: swe, drawn: true },
      ],
    });

    const expected = swe;
    const actual = layout.spaceOf('c-alpha');

    expect(actual).toBe(expected);
  });

  test('a fresh layout arriving with no spaces is a legal layout', () => {
    const layout = new Layout({ spaces: [], placements: [] });

    const expected: string[] = [];
    const actual = layout.spaces.map((s) => s.id);

    expect(actual).toEqual(expected);
  });
});
