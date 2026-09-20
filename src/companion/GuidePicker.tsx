/**
 * The guide shelf, on the create screen.
 *
 * Making a guide used to be a step wedged between pressing Generate and the
 * world being ready, which meant you could only ever make one, and only while
 * a world was building. It lives here instead: a card showing who will be
 * walking with you, a shelf of everyone you have made, and a way to add or
 * throw away without a world in sight.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { GuideStudio } from "./GuideStudio.tsx";
import {
  chooseGuide, deleteGuide, guideEnabled, listGuides, selectedGuideId,
  selectGuide, setGuideEnabled, type GuideSummary,
} from "./store.ts";

interface Props {
  /** "dark" for the photograph landing card, which is nearly black. */
  tone?: "light" | "dark";
  /** Fired whenever which guide you walk with changes, including on or off. */
  onChange?: () => void;
}

export function GuidePicker({ tone = "light", onChange }: Props) {
  const [guides, setGuides] = useState<GuideSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(selectedGuideId);
  const [enabled, setEnabled] = useState(guideEnabled);
  const [open, setOpen] = useState(false);
  const [making, setMaking] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const shelf = useRef<HTMLDivElement>(null);

  const apply = useCallback((list: GuideSummary[]) => {
    setGuides(list);
    setSelected(selectedGuideId());
    setLoaded(true);
  }, []);
  const refresh = useCallback(async () => apply(await listGuides()), [apply]);

  useEffect(() => {
    let live = true;
    void listGuides().then((list) => { if (live) apply(list); });
    return () => { live = false; };
  }, [apply]);

  // A shelf that stays open behind whatever you click next is a shelf in the way.
  useEffect(() => {
    if (!open) return;
    const away = (event: MouseEvent) => {
      if (!shelf.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const current = chooseGuide(guides, selected, true);

  const choose = (id: string) => {
    if (id === current?.id) { setOpen(false); return; }
    selectGuide(id);
    setSelected(id);
    setOpen(false);
    onChange?.();
  };

  const remove = async (guide: GuideSummary) => {
    const walkingWithThem = guide.id === current?.id;
    await deleteGuide(guide.id);
    await refresh();
    // Deleting anyone else changes nothing about who you are walking with.
    if (walkingWithThem) onChange?.();
  };

  const toggle = (on: boolean) => {
    setGuideEnabled(on);
    setEnabled(on);
    if (on && !guides.length) setMaking(true);
    else onChange?.();
  };

  return <div className={`guide-shelf is-${tone}`} ref={shelf}>
    <span className="eyebrow">YOUR GUIDE</span>

    <button
      className={`guide-slot${enabled ? "" : " is-off"}`}
      type="button"
      aria-haspopup="true"
      aria-expanded={open}
      onClick={() => (guides.length ? setOpen((was) => !was) : setMaking(true))}
    >
      {current?.portrait
        ? <img src={current.portrait} alt="" />
        : <span className="guide-slot-empty" aria-hidden="true">{loaded && !guides.length ? "+" : ""}</span>}
      <span className="guide-slot-name">
        {!loaded ? "…" : current ? current.name : "Make a guide"}
      </span>
      {loaded && !!guides.length && <span className="guide-slot-hint" aria-hidden="true">change</span>}
    </button>

    <label className="guide-toggle">
      <input type="checkbox" checked={enabled} onChange={(event) => toggle(event.target.checked)} />
      <span>{enabled ? "Walk with a guide" : "Walk alone"}</span>
    </label>

    {open && <div className="guide-shelf-panel" role="menu">
      <p className="eyebrow">CHOOSE A GUIDE</p>
      <div className="guide-shelf-grid">
        {guides.map((guide) => <div key={guide.id} className={`guide-tile${guide.id === current?.id ? " is-current" : ""}`}>
          <button type="button" role="menuitem" onClick={() => choose(guide.id)} title={guide.name}>
            {guide.portrait ? <img src={guide.portrait} alt="" /> : <span aria-hidden="true" />}
            <b>{guide.name}</b>
          </button>
          <button
            className="guide-tile-remove" type="button"
            aria-label={`Delete ${guide.name}`} title={`Delete ${guide.name}`}
            onClick={() => void remove(guide)}
          >×</button>
        </div>)}
        <button className="guide-tile-new" type="button" onClick={() => { setOpen(false); setMaking(true); }}>
          <span aria-hidden="true">+</span>New guide
        </button>
      </div>
    </div>}

    {making && <GuideStudio onClose={(made) => {
      setMaking(false);
      if (made) { setGuideEnabled(true); setEnabled(true); }
      void refresh().then(() => { if (made) onChange?.(); });
    }} />}
  </div>;
}
