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
  test('a placed conversation lives in the space it was put in', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);

    const expected = tower;
    const actual = layout.spaceOf('c-alpha');

    expect(actual).toBe(expected);
  });

  test('a conversation nobody has filed lives nowhere', () => {
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

  test('a conversation placed twice lives in the space it went to last', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.place('c-alpha', swe);

    const expected = swe;
    const actual = layout.spaceOf('c-alpha');

    expect(actual).toBe(expected);
  });

  test('taking a conversation out leaves it living nowhere', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.unplace('c-alpha');

    const expected = null;
    const actual = layout.spaceOf('c-alpha');

    expect(actual).toBe(expected);
  });
});

describe('the filing gesture', () => {
  test('the gesture files a conversation into the space it is not in', () => {
    const layout = twoSpaces();
    layout.togglePlacement('c-alpha', tower);

    const expected = tower;
    const actual = layout.spaceOf('c-alpha');

    expect(actual).toBe(expected);
  });

  test('the same gesture takes it out again', () => {
    const layout = twoSpaces();
    layout.togglePlacement('c-alpha', tower);
    layout.togglePlacement('c-alpha', tower);

    const expected = null;
    const actual = layout.spaceOf('c-alpha');

    expect(actual).toBe(expected);
  });

  test('the gesture in a second space moves it there rather than taking it out', () => {
    const layout = twoSpaces();
    layout.togglePlacement('c-alpha', tower);
    layout.togglePlacement('c-alpha', swe);

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

describe('clearing a conversation off the screen', () => {
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

  test('a space lists the conversations of its own that are off the screen', () => {
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

  test('a conversation that has been away keeps its position among the others', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.place('c-beta', tower);
    layout.minimise('c-alpha');
    layout.restore('c-alpha');

    const expected = ['c-alpha', 'c-beta'];
    const actual = layout.drawnIn(tower);

    expect(actual).toEqual(expected);
  });

  test('filing a minimised conversation into the space it is already in brings it back', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.minimise('c-alpha');
    layout.place('c-alpha', tower);

    const expected = ['c-alpha'];
    const actual = layout.drawnIn(tower);

    expect(actual).toEqual(expected);
  });
});

describe('what is on the screen', () => {
  test('the space in front draws the conversations placed in it', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.place('c-beta', swe);
    layout.showSpace(tower);

    const expected = ['c-alpha'];
    const actual = layout.drawn;

    expect(actual).toEqual(expected);
  });

  test('standing in no space draws nothing', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);

    const expected: string[] = [];
    const actual = layout.drawn;

    expect(actual).toEqual(expected);
  });

  test('a space whose conversations are all minimised is walked into empty', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.minimise('c-alpha');
    layout.showSpace(tower);

    const expected: string[] = [];
    const actual = layout.drawn;

    expect(actual).toEqual(expected);
  });

  test('what streams is what is on the screen', () => {
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
  test('going to a conversation lands in the space it lives in', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', swe);
    layout.showSpace(tower);
    layout.goTo('c-alpha');

    const expected = swe;
    const actual = layout.shownSpace;

    expect(actual).toBe(expected);
  });

  test('going to a conversation changes nothing about where it lives', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', swe);
    layout.place('c-beta', swe);
    layout.goTo('c-alpha');

    const expected = ['c-alpha', 'c-beta'];
    const actual = layout.placedIn(swe);

    expect(actual).toEqual(expected);
  });

  test('going to a minimised conversation does not bring it back onto the screen', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', swe);
    layout.minimise('c-alpha');
    layout.goTo('c-alpha');

    const expected: string[] = [];
    const actual = layout.drawn;

    expect(actual).toEqual(expected);
  });

  test('a conversation living nowhere offers nowhere to go', () => {
    const layout = twoSpaces();

    const expected = false;
    const actual = layout.goTo('c-alpha');

    expect(actual).toBe(expected);
  });

  test('failing to go somewhere leaves you where you were', () => {
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

  test('narrowed to this space, the rail lists only what lives here', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.place('c-beta', swe);
    layout.showSpace(tower);
    layout.setScope('space');

    const expected = ['c-alpha'];
    const actual = layout.railRows(register);

    expect(actual).toEqual(expected);
  });

  test('narrowed to this space while standing nowhere, the rail lists nothing', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);
    layout.setScope('space');

    const expected: string[] = [];
    const actual = layout.railRows(register);

    expect(actual).toEqual(expected);
  });

  test('narrowed to the unfiled, the rail lists only conversations living nowhere', () => {
    const layout = twoSpaces();
    layout.place('c-alpha', tower);

    layout.setScope('unplaced');

    const expected = ['c-beta', 'c-gamma'];
    const actual = layout.railRows(register);

    expect(actual).toEqual(expected);
  });

  test('a conversation filed away leaves the unfiled queue', () => {
    const layout = twoSpaces();
    layout.setScope('unplaced');
    layout.place('c-beta', tower);

    const expected = ['c-alpha', 'c-gamma'];
    const actual = layout.railRows(register);

    expect(actual).toEqual(expected);
  });

  test('a search by id finds a conversation the narrowing had hidden', () => {
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

  test('the scope narrows what the rail was already showing', () => {
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

  test('deleting the space you are standing in leaves you standing nowhere', () => {
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
