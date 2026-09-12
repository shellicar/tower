# Rail spaces

A conversation gets somewhere to live, and the rail takes you there.

Worked out in full with the Supreme Commander on 11 September 2026. Nothing built: no
branch, no code.

## Problem Statement

A conversation has no home.

In tmux an address was a path through server, session, window and pane, and it did two
jobs at once: it named the work, and it was where the work lived. Tower removed it, and
for naming that was right. The conversation id is flat and nothing contains it.

What went with it, and nobody decided this, is that a conversation now lives nowhere. The
rail is a register of everything that has ever existed, ordered by age. A tab is not a
home either: its contents are a list maintained by hand, and a conversation can appear in
two tabs or in none. Both states exist in the live layout today.

Three complaints follow from that one cause.

**Clicking a conversation cannot mean "take me there", because there is no there.** It
adds the conversation to whichever tab is in front, so the same gesture does different
things depending on where you happen to be standing, and the filing already done by hand
buys nothing back.

**Nothing can be put away,** because putting something away needs somewhere for it to go
back to. Killing a tmux pane was putting it away. Here, hundreds of conversations are
flagged as unattended and not one of them can be discharged.

**And managing many sessions is hard enough that handlers are used partly to do it.** A
handler holds a set of workers and knows where each is up to, which is the reconstruction
otherwise done in your head.

## Solution

A conversation has one placement. The rail shows where it is, and clicking it goes there.

## Vocabulary

Used throughout this spec and in the code.

**layout** — one representation of how conversations are organised: the spaces, their
nesting, and each conversation's placement among them. A conversation has at most one
placement in a layout. More than one layout can exist, each arranging the same
conversations differently.

**space** — a named place that holds conversations. It carries a name, a parent, and a
position among its siblings. A space can hold other spaces, so depth is data rather than
schema. One space is displayed at a time per client, and the conversations placed in it
are drawn tiled.

**placement** — where a conversation sits: the space, its position among the others there,
and whether it's drawn. One per conversation per layout.

**unplaced** — a conversation with no placement. It sits in no space, has no position, and
nothing draws it. It still appears in the rail, because the rail lists conversations
rather than placements.

**minimise** — stop drawing a conversation without removing its placement. It keeps its
space and its position among the others. Because it isn't displayed, its content isn't
subscribed, so nothing streams for it.

Selecting a space draws its placements: every conversation placed in it that isn't
minimised appears as a panel, tiled, in placement order.

## User Stories

1. As Stephen, I want to click a conversation in the rail and land in the space it lives
   in, so that I stop reconstructing where things are in my head.
2. As Stephen, I want clicking a conversation to change nothing, so that navigating is
   safe to do without thinking about it.
3. As Stephen, I want a conversation to live in exactly one space, so that going through
   my spaces means going through my work.
4. As Stephen, I want to see at a glance which conversations live nowhere, so that work
   that has just arrived doesn't escape me.
5. As Stephen, I want to put a conversation into the space I'm standing in with one
   deliberate gesture, so that filing is an act rather than a side effect of looking.
6. As Stephen, I want the same gesture to take it out again, so that I'm never stuck with
   something I filed by mistake.
7. As Stephen, I want placing a conversation to take it out of wherever it was, so that I
   never have to tidy up after myself.
8. As Stephen, I want to clear a conversation off the screen without taking it out of its
   space, so that I can work on three things and still know where the other seven live.
9. As Stephen, I want to bring one back onto the screen, so that I don't go hunting in the
   rail for something that is already here.
10. As Stephen, I want a space to hold more conversations than fit on the screen, so that
    a space can be everything for a client rather than only what fits at once.
11. As Stephen, I want to see which of a space's conversations aren't on the screen, so
    that putting one away isn't the same as losing it.
12. As Stephen, I want to walk into a space with nothing showing, so that I can start from
    empty rather than clearing six things first.
13. As Stephen, I want the rail to show every conversation, or only this space's, or only
    the ones living nowhere, so that I can work the unfiled ones down as a queue.
14. As Stephen, I want a search for a conversation id to find it whatever else is
    filtered, so that an id always reaches its conversation.
15. As Stephen, I want spaces to hold spaces when I want them to, so that changing between
    one, two and three levels doesn't mean changing the model.
16. As Stephen, I want a space with nothing in it to keep existing, so that moving my last
    conversation out doesn't silently delete the space and how I had it sliced.
17. As Stephen, I want to be able to have no spaces at all, so that a fresh database
    doesn't invent one for me.
18. As Stephen, I want deleting a space to release everything in it, so that the
    conversations survive and only the arrangement goes.
19. As Stephen, I want a script to be able to file conversations, so that filing can be
    automated without tower deciding anything about where work belongs.
20. As Stephen, I want minimised conversations to stop streaming, so that a space holding
    thirty doesn't cost thirty conversations' worth of traffic to stand in.
21. As Stephen, I want every client I have open to show the same arrangement, so that two
    browsers agree about where things live.
22. As Stephen, I want each client to choose which space it is showing, so that two
    windows can show two different clients' work at the same time.

## Implementation Decisions

**The model.** A layout holds spaces and placements. A space carries a name, a parent and
a position among its siblings; an absent parent means top level, so depth is data rather
than a fixed number of levels. A placement carries the space, whether the conversation is
drawn, and its position among the others in that space.

**Exclusivity is structural.** A placement is keyed by layout and conversation, so one
space per conversation is a constraint rather than a convention two clients agree to
follow. Wanting a conversation in two places is answered by a second layout, not by
loosening the key.

**The daemon holds the structure.** Today the whole arrangement is one opaque document the
daemon never reads, which is why exclusivity could only ever have been a convention.
Spaces and placements become things it understands.

**The relational form, not a duplicated path.** Storing the space as a path string on each
conversation was considered and rejected: renaming a level rewrites every conversation
carrying it, the separator becomes a reserved character in space names, and the two
frontends would parse strings differently rather than doing the same lookup. A space table
has to exist regardless, since an empty space must be able to exist and sibling order must
live somewhere, so duplication buys nothing and pays with an invariant no database can
hold.

**The browser contract carries spaces and placements.** The exact frame shape is
determined by the spike and written into the browser contract document before any
implementation begins. Clients send a whole snapshot rather than individual operations,
and last write wins; operations would only earn their keep to stop a stale client
clobbering, which is not a concern at this scale.

**What stays with the client.** Which space a client is showing, and how it has sliced the
rail, are facts about that client and not part of the layout.

**Navigation and filing are different mouse buttons.** The primary button on a rail row
goes to the space the conversation lives in and changes nothing; a conversation living
nowhere offers no navigation. The secondary button toggles the conversation's placement in
the space currently shown, and because placement is exclusive, placing it there removes
any previous placement. The browser's own menu stays available behind a modifier.

**The panel's close control minimises.** It does not unplace. Restoring is offered on the
rail row, which is where a space's minimised conversations are listed.

**Subscription follows what is drawn.** The set of conversations whose content streams is
the set on screen, rather than the set placed in the current space. A minimised
conversation stops streaming.

**Deleting a space releases its conversations.** They become unplaced; nothing is lost but
the arrangement.

**Empty is legal at both levels.** A space may hold nothing, and there may be no spaces at
all. Nothing creates a default space.

**A prefactor comes first.** The frontends' concerns gain the two questions their
components currently answer for themselves: what is displayed here, and where does this
conversation live. The components stop reading the membership list directly. Without this,
splitting membership from visibility leaves every one of those readers ambiguous.

**Filing is reachable from outside the browser**, at first by whatever route the existing
tagging script uses. Deciding where a conversation belongs is a script's opinion and never
the daemon's.

## Testing Decisions

**What makes a good test here.** It drives the model through the operations a person
performs and checks the state that results, rather than which methods were called.
Scenarios are written in business terms, so the same scenario runs at more than one scope
and in both frontends without being rewritten.

**Three scopes**, each named by what is inside it.

*The model on its own.* Inside: spaces, placements, exclusivity, minimise, the rail's
scope, and where a conversation resolves to. Outside: nothing. It has no awkward
collaborators, so nothing is substituted and no apparatus is needed. Inputs are the
operations a person performs; outputs are the queries. This carries most of the feature's
behaviour, and it runs once per frontend.

*The concern around it.* Inside: the model, the fold that turns server frames into it, and
the transport. Outside: the daemon, stood in for at the socket, which is the single
substitution. Proves that a layout frame produces the right model state, that an operation
produces the right outbound message, and that minimising something stops it being
subscribed. Runs once per frontend.

*The daemon over the socket.* Inside: the socket layer, the fold, the store. Outside: the
browser, and the broker, which is the single substitution. Proves exclusivity as a key,
that deleting a space releases its conversations, that no spaces is a legal state, and the
shape of the contract. Runs once.

**Why these three.** Each substitution sits on a communication boundary, where neither
side knows the other's internals already, which is what makes standing in for one side
cheap and stable. The joins inside a process are not boundaries: substituting there means
reaching into the application, which is what the current frontend tests do by feeding
typed messages straight to a concern.

**Prior art.** Both frontends already have tests that construct a concern with no DOM and
assert on what it reports. The daemon already has tests that apply raw events to an
in-memory store and assert on queries. Where a rule lives in a component and cannot be
reached, the established move is to give the concern a method that takes the component's
already-filtered list and decides whether to honour it, which ports between the two
languages unchanged.

**What nothing covers.** That a component wires a click to the right operation. That stays
open until a DOM layer exists, which is deliberately last.

## Out of Scope

**Identification.** This change fixes navigation and does not touch telling two
conversations apart. A quarter of the titles in the database begin with the same word, and
two conversations carry byte-identical ones. A title distinguishes; it does not let you
recognise. The answer is a full-width surface carrying the opening ask in your own words,
the last reply, the figures, and a fold that shows the tail in place. Its own piece of
work.

**Archive.** Distinct from minimise. Minimised is off the screen and still in the rail;
archived is gone from the rail too. The word "hide" is deliberately left unspent for it.

**Automatic placement.** A script's job, never the daemon's.

**A chip showing which world is serving a conversation.** A fact the daemon already folds
and never shows.

**Reordering spaces.** Currently impossible, and this change makes the existing workaround
destructive, so it follows shortly after rather than being included.

**Multiple layouts.** The key allows them; nothing else does.

**The DOM layer.** Driving either frontend through a browser. Last.

## Further Notes

**Order of work.** The daemon and the Rust frontend share a compiled contract, so they
move together and the compiler checks both ends of the wire before anything is copied by
hand. The Svelte frontend follows, and its hand-mirrored types are safest copied from a
shape two compiled consumers have already agreed on. Both land in the same pull request,
so nothing merges until both work; whichever is unported mid-branch will be broken rather
than merely behind.

**The spike.** The demo is a spike whose output is knowledge plus one artifact that
survives: the model as a plain class. Its last act is writing the frame shape into the
browser contract. Without that, the shape gets written to suit whatever the daemon finds
convenient to serialise, and the client adapts to it for the rest of its life.

**Naming findings, not part of this change.** The word "stale" carries three unrelated
meanings in tower: how long since a conversation moved, an unattended episode past its
timer, and a say rejected because the tip moved. The rail's unread control filters on the
second while its tooltip describes something else. And "attachment" means both an agent's
claim on a conversation and a file attached to a message; the file one is the one to
rename.

## What is mine, not yours

The Supreme Commander's decisions are in the Problem Statement, the Vocabulary, the User
Stories and the Implementation Decisions, each of which records something he said or
agreed. The following are Claude's:

- The diagnosis that the navigation complaint, the absence of "done", and the use of
  handlers are one problem rather than three. He accepted it rather than proposing it.
- The rail's scope being independent of the space in front, which he had not considered,
  and its three values.
- The claim that the prefactor is forced rather than optional.
- The claim that minimise is required rather than optional, because placement becoming
  durable removes the transient gesture the current click provides.
- The mapping onto tiling window managers: spaces, minimise, and the unplaced state as a
  scratchpad. He confirmed the family and ruled out free-floating windows.
- The analysis behind each rejected word. The choices of space, placement and minimise are
  his.
- The three test scopes and the argument that each substitution belongs on a communication
  boundary.
- Every phrasing in this document, and its section order.
