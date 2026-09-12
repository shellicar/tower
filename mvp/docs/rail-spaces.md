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
space. Because it isn't displayed, its content isn't subscribed, so nothing streams for
it. Restoring draws it last among the others rather than returning it to where it sat,
which is what makes minimising and restoring the way to reorder a space until reordering
has a gesture of its own.

Selecting a space draws its placements: every conversation placed in it that isn't
minimised appears as a panel, tiled, in placement order.

## User Stories

1. As Stephen, I want to click a conversation in the rail and land in the space it lives
   in, so that I stop reconstructing where things are in my head.
2. As Stephen, I want clicking a conversation never to change where it lives, so that
   navigating is safe to do without thinking about it.
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

**The browser contract carries spaces and placements.** The frame shape was determined by
the spike and is written into `tower-ws-spec.md`, under `set_layout` and `layout`. Clients
send a whole snapshot rather than individual operations, and last write wins; operations
would only earn their keep to stop a stale client clobbering, which is not a concern at
this scale. Three things the spike settled and the contract now states: the client mints
space ids, because a snapshot must be able to name a space it creates in the same breath;
there is no position field, because array order cannot disagree with itself; and
placements are a flat list keyed by conversation rather than nested inside spaces, because
nesting would make one conversation in two spaces expressible.

**What stays with the client.** Which space a client is showing, and how it has sliced the
rail, are facts about that client and not part of the layout.

**Navigation and filing are different mouse buttons, and neither is routed by state.** An
operation that does one thing when something is placed and another when it is not leaves
you unable to predict the fifth click from the first, which is the fault of the taskbar
button that minimises or restores depending on what it is already doing.

The primary button on a rail row shows the space the conversation is placed in and draws
the conversation, restoring it if it was minimised. Running it again lands in the same
state rather than putting it away. An unplaced conversation has no space to show, so it
does nothing and says so.

The secondary button places the conversation in the space shown. It never removes: already
there, it does nothing, and anywhere else, it moves here, which because placement is
exclusive takes it out of where it was. Every press ends in the same sentence, that this
conversation is in this space. The browser's own menu stays available behind a modifier.

**The panel carries both controls, with the meanings every window manager already gives
them.** `–` minimises, and `×` takes the conversation out of the space. The earlier
decision that `×` should minimise was justified by unplacing being destructive and hard to
undo, and that reasoning does not hold: removal is meant to be easy rather than guarded,
and unplacing is rare, so it gets the cheapest control that already exists. Finishing with
something happens on the thing itself, rather than by hunting its row in a rail of
hundreds.

**Restoring is offered on the rail row.** Scoped to the space shown, the rail is that
space's index: every conversation placed there, with the minimised ones marked. There is
no second surface on the panel region, which was tried and removed.

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

## Presentation

Worked out by building it and using it, September 2026, in the spike at
`spike/rail-spaces/`. The first implementation is in Rust and cannot read that markup, so
what it settled is written out here. The words are the Vocabulary's throughout: a
conversation is placed or unplaced, drawn or minimised, and the region holding the panels
has no name.

### The rail row

Left to right: the unread dot, the liveness dot, the title or the id when it has no title.
Then, right-aligned, the space it is placed in, the last event kind, and its age coloured
by heat. Tag badges sit on a second line, and carry the value alone because the colour
already says which key it is.

**The space reads as a filled badge when the conversation is placed in the space shown,
and as an outlined one when it is placed somewhere else.** Minimised dims the same badge
rather than adding a word beside it, so the row's width does not move as conversations
come and go.

**An unplaced conversation shows nothing in that slot, and carries no highlight.** The
rail lists the register and only a handful of conversations are ever placed, so unplaced
is what a conversation normally is, and a highlight on the normal state is decoration. The
filed ones are what the eye should catch. Arrivals are not lost by this: the rail is
ordered by last event with the age coloured, so something that has just moved and has no
space sits at the top, fresh, with an empty slot. The scope below is the deliberate look.

### The rail's controls, and what each belongs to

The header is two blocks, because two different things own these controls and a reader
otherwise cannot tell which will follow them out of the space.

The first block is the reader's, and travels with them:

- **scope**, one of all, this space, unplaced. Two of its three values are written
  relative to the space shown, so it re-evaluates as you walk and the rail follows you.
  Holding it per space would instead mean walking into a space silently changed what the
  rail was showing.
- **filter**: the conversation id box, and the live and unread toggles. These are about
  attention rather than about a subject, and sweeping for what needs you is the act they
  serve, so they must survive walking between spaces.
- **show**, which tag keys appear as badges on a row. This is about the shape of a row.
  Per space it would usefully hide the badge that is redundant inside a space, but a badge
  that vanishes as you walk reads as missing data rather than as a setting.

The second block is the space's, headed by its name, on its own ground, with its own
control to clear it. It holds **group** (and hide untagged) and **filter** by tag. Both
are about a subject, and a space is a subject: standing in flightrac you want repo
Flightrac, and carrying that into tower is wrong every time. A space with nothing set
shows an empty block rather than creating one, and showing no space is itself a heading,
so the controls still work when nothing is in front.

`filter` therefore appears in both blocks. That is correct rather than a collision:
there are filters in both, and the block a filter sits in is what says whose it is. The
leading word of each row sits in a column down the left rather than inline, because at the
rail's width the chips wrap and an inline word gets pushed away from what it labels.

The id search suspends everything else rather than composing with it, which is the
existing rule. It is not cleared for the reader when they navigate: it announces itself
loudly, because every other control greys out while it is set, so deciding on their behalf
that they have finished with it buys nothing.

**The model is handed the whole register alongside the filtered list.** The id search has
to reach past the rail's own filters as well as past the scope, so a model given only what
the filters left cannot honour the rule that an id always finds its conversation.

### The space strip

Two rows rather than indentation. The first holds the top-level spaces. Once one of them
is shown, whether directly or through one of its children, a second row appears beneath it
holding that space's children. Containment is carried by the row, which an indent prefix
fails to do once there are real sibling counts.

A chip shows the space's name, the count of conversations placed there when it is not
zero, and the unread count when there is one. Clicking a chip always shows that space and
never does anything else. Each row's own `+` creates a space at that row's level, and the
chip for the space being shown carries the control to delete it, which confirms and says
what will be released.

### The panel

`–` minimises and `×` unplaces, as above. The panel a reader arrived at by clicking a rail
row is ringed briefly, because arriving among eight panels otherwise means re-reading
titles to find the one you asked for.

### What has no design yet

Placing always draws, and nothing limits how many conversations a space holds, so a space
with eight in it tiles eight panels and the region scrolls sideways past the window's
edge. Whether that should be capped, paged, or left alone is open.

Reordering conversations within a space is minimising and restoring, which is a side
effect rather than a gesture. It belongs with reordering spaces, which is already parked.

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

**The spike.** Built at `spike/rail-spaces/`, against a static fixture taken from a
read-only snapshot of the live database: every conversation, real titles, real tags, the
spaces that already exist, and the standing agent attachments so liveness folds as it
really does. The spaces arrive empty, because placing is the operation everything else
hangs off and an app that starts arranged never gets it tried. Two things survive it: the
model as a plain class, with its tests, and the two sections above. The frame shape is
written into the browser contract, without which it would have been written to suit
whatever the daemon found convenient to serialise, and the client would have adapted to it
for the rest of its life.

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
- The whole Presentation section, except where it records a decision he made while using
  it: that restoring appends, that there is one surface for a space's minimised
  conversations rather than two, and that the id search is not cleared on his behalf.
- The argument that the panel should carry both controls, and that `×` should mean what it
  means everywhere else. He accepted it and supplied the reason the original decision was
  wrong.
- The argument for dropping the unplaced highlight.
- Every phrasing in this document, and its section order.

The rule that an operation must never be routed by state is his, and it settled the
mouse buttons.
