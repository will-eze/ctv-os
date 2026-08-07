#!/usr/bin/env python3
"""Merge the handover's standing to-do list into data/year.json.

Everything actionable in the handover that is NOT tied to a single event date —
Section Ia's checklist, and the running obligations in Sections Ic and III–VIII.
Per-event work already lives on the event as prep.

Each task carries:
  source      the handover section it came from, so it can be checked
  area        setup | training | money | socials | team | nasta | legacy
  owner_role  who the handover says owns it
  anchor      an event id; the task is due `lead_days` BEFORE that event, so it
              moves when the event moves. Nothing in this year is confirmed.
  due         a fixed date, for the few things pinned to the calendar

Idempotent: re-running replaces the tasks array rather than appending.
"""
import json
import pathlib

FRESHERS = "ww-fri"  # Welcome Weekend night 1 — the year really starts here

# (id, title, detail, area, source, owner, anchor, lead_days, due)
T = [
    # --- Section Ia: admin before freshers week ---------------------------
    ("outlook", "Get Helen to give you access to the ctvmanager mailbox",
     "Log in to your own Outlook account, then open the other mailbox from there.",
     "setup", "Ia", "Station Manager", FRESHERS, 35, None),
    ("socials-audit", "Log into Instagram and YouTube and review the last few years",
     "Caela will pass you the passwords. The whole committee needs Instagram access so they can post. "
     "Delete nothing from previous years — cover images are fine for neatening the feed.",
     "setup", "Ia", "Station Manager", FRESHERS, 35, None),
    ("drive-folder", "Make this year's Google Drive folder",
     "Copy the structure of the last few years. Change the folder text colour on your laptop so you "
     "do not confuse it with last year's.",
     "setup", "Ia", "Station Manager", FRESHERS, 35, None),
    ("su-training", "Complete the SU leadership training",
     "Dull, mandatory, and it is where the finance forms are explained.",
     "setup", "Ia", "Station Manager", FRESHERS, 42, None),
    ("finance-training", "Complete the mandatory finance training module",
     "Section IIIa — required before you can start the role.",
     "money", "IIIa", "Station Manager", FRESHERS, 42, None),
    ("wa-committee", "Make the WhatsApp committee chat",
     None, "setup", "Ia", "Station Manager", FRESHERS, 35, None),
    ("wa-community", "Make the CampusTV 2026/27 WhatsApp community and general chat",
     "Monitor it for bots. Make the whole committee admin.",
     "setup", "Ia", "Station Manager", FRESHERS, 35, None),
    ("drive-access", "Add everyone to the Drive as a contributor",
     "Ela needs manager so she can create marketing folders. Make sure everyone knows to upload "
     "edited AND unedited content, plus marketing material.",
     "setup", "Ia", "Station Manager", FRESHERS, 21, None),
    ("merch", "Order merch — joint order with the other media groups",
     "T-shirts, hoodies, leaflets. Three to four weeks ahead. A joint order cuts the delivery cost.",
     "setup", "Ia", "Station Manager", FRESHERS, 28, None),
    ("fair-table", "Book the freshers fair table",
     "The booking email lands in the ctvmanager inbox — watch for it.",
     "setup", "Ia", "Station Manager", FRESHERS, 35, None),
    ("sports-table", "Book the sports fair table",
     "Section Ib is emphatic about being at this one: it is where livestreaming gets sold.",
     "setup", "Ia", "Head of Sport", FRESHERS, 35, None),
    ("qr", "Make the QR codes and test them on two phones",
     "Three of them: the general group chat, the SU page to buy membership, and Instagram. "
     "Use a free generator. Test on two phones in case one fails.",
     "setup", "Ia", "Head of Marketing", FRESHERS, 7, None),
    ("stall-plan", "Plan the stall: sweets and TV trivia",
     "Easy / medium / hard questions for 1 / 2 / 3 sweets. Keep the categories on a TV theme — "
     "the Office, Gossip Girl, Doctor Who — so it does not overlap with Filmsoc.",
     "setup", "Ia", "Head of Marketing", FRESHERS, 14, None),
    ("backstage-rig", "Speak to Backstage about the freshers rig",
     "Note down every item you let them set up so no cable leaves with them. Cameras get rigged "
     "with you present.",
     "setup", "Ia", "Head of Tech", FRESHERS, 21, None),
    ("press-aaa", "Sort press access and AAA for the whole team",
     None, "setup", "Ia", "Station Manager", FRESHERS, 14, None),
    ("sd-cards", "Check there are enough SD cards",
     "One goes into the ATEM every arena night and gets emptied at 02:00.",
     "setup", "Ia", "Head of Tech", FRESHERS, 14, None),
    ("cam-mic-basics", "Give the team basic camera and mic training",
     "Enough that they can go out and do interviews without you.",
     "training", "Ia", "Head of Tech", FRESHERS, 10, None),
    ("davinci", "Get everyone learning DaVinci and sending you what they make",
     "It is free. The more of them who can edit, the more of pre- and post-production you can hand "
     "over when you are busy.",
     "training", "Ia", "Station Manager", FRESHERS, 21, None),
    ("delegate-freshers", "Delegate freshers coverage — who does what, and when",
     "You need to know when everyone is back in Bath and moved in. Caela used ClickUp for this.",
     "setup", "Ia", "Station Manager", FRESHERS, 21, None),
    ("meet-committee-post", "Put up the meet-the-committee post",
     "The week before freshers.",
     "socials", "Ia", "Head of Marketing", FRESHERS, 7, None),
    ("social-sec", "Make sure the social sec advertises all the groups equally",
     "Not just URB. If they will not, get Ela to make CTV adverts herself — she will need to be in "
     "contact with them either way.",
     "team", "Ia", "Head of Marketing", FRESHERS, 14, None),
    ("whats-on", "Check the SU what's-on page and decide what to cover in daytime freshers",
     "Decide as a team. Do not over-commit — most of the team cannot edit yet and the arena night "
     "edits still have to happen alongside.",
     "setup", "Ib", "Head of Production", FRESHERS, 10, None),
    ("joe-split", "Agree with Joe Rumford which daytime events he is filming",
     "So you are not both filming the same thing and posting reels about it. He generally covers "
     "what he thinks you will miss.",
     "setup", "Ib", "Station Manager", FRESHERS, 10, None),
    ("buffer", "Set up the free Buffer account",
     "Posts to Instagram, Facebook, YouTube shorts and TikTok at once. You and Ela both need to be "
     "logged in and comfortable using it before freshers.",
     "socials", "IVa", "Head of Marketing", FRESHERS, 14, None),
    ("interview-qs", "Write the interview questions",
     "Nothing that insults the SU, promotes drugs or anything illegal. Lighthearted and fun. "
     "New questions for arena nights so it does not look like the same two people.",
     "setup", "Ib", "Head of Production", FRESHERS, 5, None),

    # --- Section Ic: training and the systems that outlive freshers -------
    ("training-assist", "Get 2–3 of the team confident enough to teach",
     "They need to be able to assist at training and answer questions, not just attend.",
     "training", "Ic", "Head of Tech", None, None, "2026-09-28"),
    ("su-takeover", "Schedule an SU takeover around a big event",
     "Rugby at the Rec, fight night or a livestream. It is their stories, so plan what you show.",
     "socials", "Ic", "Head of Marketing", None, None, "2026-10-01"),
    ("event-chats", "Make a WhatsApp group chat for each event",
     None, "team", "Ic", "Head of Production", None, None, "2026-09-28"),
    ("kit-system", "Put the kit check-in / check-out system in place",
     "Head of Tech owns it. You need to know what is booked out, when it leaves and when it comes "
     "back. Ask Peter — he has thoughts on this.",
     "training", "Ic", "Head of Tech", None, None, "2026-10-05"),

    # --- Section III: money ----------------------------------------------
    ("finance-forms", "Find the finance forms and read Caela's examples",
     "thesubath.com/finance/interactive_forms — and her old emails show what a filled-in one looks "
     "like. Ask Helen if you cannot find a finance code.",
     "money", "IIIa", "Station Manager", None, None, "2026-09-14"),
    ("finance-system", "Learn the new finance system yourself",
     "It is changing. Do not rely on the treasurer to know how much money you have left — they are "
     "often not on top of it.",
     "money", "IIIc", "Station Manager", None, None, "2026-10-05"),
    ("membership-check", "Set up a way to check SU memberships before anyone touches kit",
     "SU website → settings → media exec → memberships, cross-checked against the name list.",
     "money", "IIIb", "Head of Tech", None, None, "2026-09-28"),
    ("borrow-scheme", "Ask Chris Lyons about the equipment borrowing scheme",
     "He and Jade ran it — it let members rent kit safely for their own projects.",
     "money", "IIIb", "Head of Tech", None, None, "2026-10-19"),
    ("alumni-dates", "Get the alumni fund dates from Helen and Angus",
     "One window around October/November, one in January. The later you apply the later the money "
     "arrives. Read Peter's previous applications first.",
     "money", "IIId", "Station Manager", None, None, "2026-10-05"),
    ("reimbursement", "Learn the claims flow well enough to teach it",
     "The finance app is changing. You can claim back some or all of your NaSTA ticket, and you "
     "need to be able to show everyone else how.",
     "money", "IIIe", "Station Manager", None, None, "2026-11-02"),
    ("budget-share", "Agree with the other media groups about sharing kit",
     "Ours came out of our budget — they should ask, and vice versa.",
     "money", "IIIc", "Station Manager", None, None, "2026-10-12"),

    # --- Section IV: socials ---------------------------------------------
    ("linktree", "Update the linktree",
     "Website, group chats, membership. Effective immediately once the new chats exist.",
     "socials", "IVb", "Head of Marketing", FRESHERS, 21, None),
    ("reel-covers", "Set up custom reel covers so the feed reads as one thing",
     "Short form on Instagram, and use it to push people to YouTube for livestreams and long form.",
     "socials", "IVb", "Head of Marketing", None, None, "2026-10-12"),
    ("su-website", "Update the CampusTV page on the SU website",
     "Speak to Will Kitchen about how to edit it. This is how a lot of freshers find us, and the "
     "linktree points at it.",
     "socials", "IVd", "Head of Marketing", FRESHERS, 21, None),
    ("ctv-website", "Speak to Peter about the CTV website",
     "He owns the domain now.",
     "socials", "IVe", "Station Manager", None, None, "2026-10-26"),
    ("youtube", "Get livestreams and long-form onto YouTube",
     "Treat YouTube shorts like Instagram reels — post the same content to build the channel.",
     "socials", "IVc", "Head of Marketing", None, None, "2026-11-09"),

    # --- Section V: team --------------------------------------------------
    ("roles-written", "Write down who handles what",
     "Committee roles and per-event roles. This is the thing that prevents fallouts. Remember it is "
     "a society, not a job — adjust responsibility when interest wanes.",
     "team", "Va", "Station Manager", FRESHERS, 21, None),
    ("safeguarding", "Complete the safeguarding training",
     "You are the HR if it is needed.",
     "team", "Vb", "Station Manager", FRESHERS, 30, None),
    ("speak-up", "Make sure the team know to tell you if something is off",
     "Especially the women in leadership roles, and especially around Backstage. Caela was explicit "
     "about this.",
     "team", "Vb", "Station Manager", FRESHERS, 7, None),
    ("ctv-socials", "Decide whether to run CTV-only socials",
     "Someone can take on a CTV social sec role alongside their main one if the group wants it.",
     "team", "Vc", "Station Manager", None, None, "2026-10-19"),

    # --- Section VI: NaSTA ------------------------------------------------
    ("nasta-chats", "Join the NaSTA regional and main group chats",
     "Caela cannot add you — message the NaSTA Instagram account for the links. The whole team can "
     "join everything except the station manager chat.",
     "nasta", "VIc", "Station Manager", None, None, "2026-10-12"),
    ("nasta-categories", "Read the categories and plan projects to the spec",
     "nasta.tv/awards, and there is a detailed PDF at the bottom of the page. Plan content to fit "
     "categories rather than hunting for entries in April.",
     "nasta", "VIb", "Station Manager", None, None, "2026-10-12"),
    ("nasta-fee", "Pay the NaSTA membership fee",
     "The email lands in the ctvmanager account. If the payment gives trouble, message the NaSTA "
     "Instagram or ask Helen.",
     "nasta", "VIa", "Station Manager", None, None, "2027-01-29"),
    ("nasta-exports", "Check every submission against the export settings",
     "Getting this wrong costs you awards and can invalidate the entry. The settings are in the PDF; "
     "ask the NaSTA team if anything is unclear.",
     "nasta", "VIe", "Station Manager", "nasta-submit", 14, None),
    ("nasta-maximise", "Submit for as many categories as possible",
     "It is the only lever you have on the odds.",
     "nasta", "VIe", "Station Manager", "nasta-submit", 0, None),
    ("nasta-advertise", "Advertise the awards hard, early",
     "It genuinely is not fun when nobody goes. Push it to everyone who was involved and to the "
     "wider media membership. Nominations come out beforehand, but there are unannounced categories "
     "— do not let a quiet nominations list put people off.",
     "nasta", "VIf", "Head of Marketing", "nasta-awards", 42, None),
    ("nasta-travel", "Book group travel and a shared Airbnb",
     "Everyone together so you can look after each other. Count the number leaving and the number "
     "coming back — people wander off when there is alcohol.",
     "nasta", "VIg", "Station Manager", "nasta-awards", 28, None),
    ("nasta-subsidy", "Ask the exec what can be subsidised",
     "Tickets certainly, accommodation possibly — Helen will know whether the budget can cover it.",
     "nasta", "VIg", "Station Manager", "nasta-awards", 35, None),

    # --- Sections VII & VIII: what keeps CTV alive ------------------------
    ("successor", "Secure a station manager for next year",
     "Caela's closing note names this as the priority that keeps CampusTV alive. Start looking long "
     "before you need to.",
     "legacy", "VII", "Station Manager", "handover", 60, None),
    ("write-handover", "Write next year's handover",
     "CTV OS can export it from everything logged during the year, but it still needs your judgement "
     "on top.",
     "legacy", "VII", "Station Manager", "handover", 7, None),
    ("peter-notes", "Chase Peter for his section of the handover",
     "Section VIII is still 'TBC when he has time'. He has run the station three times and has the "
     "kit check-in/check-out system in his head.",
     "legacy", "VIII", "Station Manager", None, None, "2026-09-21"),
]

KEYS = ("id", "title", "detail", "area", "source", "owner_role", "anchor", "lead_days", "due")


def main() -> None:
    root = pathlib.Path(__file__).resolve().parent.parent
    path = root / "data" / "year.json"
    data = json.loads(path.read_text())

    tasks = [dict(zip(KEYS, row)) | {"done": False} for row in T]

    ids = [t["id"] for t in tasks]
    if len(ids) != len(set(ids)):
        dupes = {i for i in ids if ids.count(i) > 1}
        raise SystemExit(f"duplicate task ids: {sorted(dupes)}")

    event_ids = {e["id"] for e in data["events"]}
    bad = {t["anchor"] for t in tasks if t["anchor"] and t["anchor"] not in event_ids}
    if bad:
        raise SystemExit(f"tasks anchored to events that do not exist: {sorted(bad)}")

    data["tasks"] = tasks
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")

    by_area = {}
    for t in tasks:
        by_area[t["area"]] = by_area.get(t["area"], 0) + 1
    anchored = sum(1 for t in tasks if t["anchor"])
    print(f"{len(tasks)} tasks written — {anchored} anchored to events, "
          f"{len(tasks) - anchored} on fixed dates")
    for area, n in sorted(by_area.items(), key=lambda x: -x[1]):
        print(f"  {area:10} {n}")


if __name__ == "__main__":
    main()
