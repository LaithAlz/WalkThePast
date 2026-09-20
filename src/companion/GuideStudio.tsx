/**
 * Making one guide.
 *
 * An overlay rather than a page: it is opened from the avatar shelf on the
 * create screen, and you come back to what you were doing. Choosing between
 * guides, and throwing them away, belong to the shelf — this only makes them.
 *
 * The person in the photograph is not the person you play. You stay behind your
 * own eyes with no body at all; what you are making here is the historian who
 * walks beside you.
 */
import { useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { createPortal } from "react-dom";
import { AVATURN_URL, downloadAvatar, openAvaturn, renderPortrait, type AvaturnSession } from "./avaturn.ts";
import { saveGuide, type GuideSummary } from "./store.ts";

type Stage = "intro" | "creating" | "building" | "naming" | "error";

interface Draft {
  glb: ArrayBuffer;
  avatarId: string;
  portrait: string;
}

interface Props {
  /** The new guide, already saved and selected, or null if nothing was made. */
  onClose: (made: GuideSummary | null) => void;
}

export function GuideStudio({ onClose }: Props) {
  const [stage, setStage] = useState<Stage>("intro");
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  const session = useRef<AvaturnSession | null>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      session.current?.dispose();
      session.current = null;
    };
  }, []);

  const fail = (message: string) => {
    if (!live.current) return;
    setError(message);
    setStage("error");
  };

  /** Everything downstream of "we have the bytes", whatever produced them. */
  const accept = async (glb: ArrayBuffer, avatarId: string, suggested = "") => {
    setStage("building");
    const portrait = await renderPortrait(glb);
    if (!live.current) return;
    setDraft({ glb, avatarId, portrait });
    setName(suggested);
    setStage("naming");
  };

  const begin = async () => {
    setError(null);
    setStage("creating");
    try {
      const container = host.current;
      if (!container) throw new Error("The creator could not be opened");
      const opened = await openAvaturn(container, AVATURN_URL);
      if (!live.current) { opened.dispose(); return; }
      session.current = opened;
      const url = await opened.exported;
      if (!live.current) return;
      setStage("building");
      const { glb, avatarId } = await downloadAvatar(url);
      if (!live.current) return;
      session.current?.dispose();
      session.current = null;
      await accept(glb, avatarId);
    } catch (cause) {
      session.current?.dispose();
      session.current = null;
      fail(cause instanceof Error ? cause.message : String(cause));
    }
  };

  /** Development only: any rigged humanoid GLB, straight past the creator. */
  const loadFile = async (file: File | undefined) => {
    if (!file) return;
    setError(null);
    const stem = file.name.replace(/\.glb$/i, "");
    try {
      await accept(await file.arrayBuffer(), stem, stem.slice(0, 28));
    } catch (cause) {
      fail(cause instanceof Error ? cause.message : String(cause));
    }
  };


  const keep = async () => {
    if (!draft || saving) return;
    setSaving(true);
    try {
      const saved = await saveGuide({
        glb: draft.glb, avatarId: draft.avatarId,
        name: name.trim() || "Your guide", portrait: draft.portrait,
      });
      onClose(saved);
    } catch (cause) {
      setSaving(false);
      fail(cause instanceof Error ? cause.message : "The guide could not be saved in this browser");
    }
  };

  // Avaturn's shared demo project is slow, their own project needs signing up
  // for, and neither is any use at four in the morning with a demo to give.
  // Kept in every build: the team's guides are Avaturn exports loaded as files, and the
  // deployed site has no Avaturn project of its own.
  const devEntry = <div className="guide-dev">
    <span className="eyebrow">LOAD A RIGGED MODEL</span>
    <p>Already have a rigged humanoid <code>.glb</code>? Load it straight in, past Avaturn.
      Avaturn, Ready Player Me and Mixamo exports all work — bone names are read by meaning.
      A photograph goes through <b>Use a photo</b> above; turning one into a rigged mesh is
      Avaturn's job, not something this can do locally.</p>
    <div className="guide-dev-actions">
      <input type="file" accept=".glb,model/gltf-binary" onChange={(event) => { void loadFile(event.target.files?.[0]); event.currentTarget.value = ""; }} />
    </div>
  </div>;

  const swallowDrop = (event: ReactDragEvent) => { event.preventDefault(); event.stopPropagation(); };

  // Rendered into the body, not where it sits in the tree.
  //
  // The shelf lives inside .upload-layout, which is position: relative with a
  // z-index — and that makes it a stacking context. Every descendant paints
  // inside it at that one level, so the header above it wins no matter what
  // z-index this overlay claims. A modal has to leave the subtree to escape.
  return createPortal(<div
    className="guide-overlay" role="dialog" aria-modal="true" aria-label="Make a guide"
    onDragEnter={swallowDrop} onDragOver={swallowDrop} onDrop={swallowDrop}
  >
    <div className={`guide-stage${stage === "creating" ? " is-live" : ""}`}>
      <div className="guide-avaturn" ref={host} aria-label="Avatar creator" />
      {stage !== "creating" && <div className="guide-card">
        <button className="guide-close" type="button" aria-label="Close" onClick={() => onClose(null)}>×</button>

        {stage === "intro" && <>
          <p className="eyebrow blue">NEW GUIDE</p>
          <h1>Who is<br /><em>showing you round?</em></h1>
          <p className="lede">
            Give Avaturn a photograph — a selfie, or a portrait of whoever should be showing you
            round — and it turns that face into a rigged character, in your browser, in about a
            minute. They become the historian who walks the world with you, pointing things out and
            answering when you hold <kbd>Space</kbd>.
          </p>
          <p className="guide-note">
            You stay behind your own eyes — the face belongs to your guide, not to you. Upload the
            photograph inside Avaturn's own step, on the screen after this one. It never leaves your
            browser, and neither does the character.
          </p>
          {devEntry}
          <div className="guide-actions">
            <button className="button" type="button" onClick={() => void begin()}>Use a photo</button>
            <button className="quiet-button guide-cancel" type="button" onClick={() => onClose(null)}>Cancel</button>
          </div>
        </>}

        {stage === "building" && <>
          <p className="eyebrow blue">RIGGING</p>
          <h1>Building<br /><em>your guide.</em></h1>
          <p className="guide-progress" role="status"><i aria-hidden="true" /><span>Fitting the skeleton and taking a portrait…</span></p>
        </>}

        {stage === "naming" && <>
          <p className="eyebrow blue">NEARLY THERE</p>
          <h1>Give them<br /><em>a name.</em></h1>
          {draft?.portrait && <img className="guide-portrait" src={draft.portrait} alt="Your guide" />}
          <label className="guide-name">
            <span>WHAT SHOULD THEY BE CALLED?</span>
            <input
              value={name} autoFocus maxLength={28} placeholder="Your guide"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") void keep(); }}
            />
          </label>
          <div className="guide-actions">
            <button className="button" type="button" disabled={saving} onClick={() => void keep()}>{saving ? "Saving…" : "Save this guide"}</button>
            <button className="quiet-button" type="button" disabled={saving} onClick={() => { setDraft(null); setStage("intro"); }}>Start again</button>
          </div>
        </>}

        {stage === "error" && <>
          <p className="eyebrow">DID NOT FINISH</p>
          <h1>The guide<br /><em>could not be made.</em></h1>
          <p className="auth-error" role="alert">{error}</p>
          {devEntry}
          <div className="guide-actions">
            <button className="button" type="button" onClick={() => void begin()}>Try again</button>
            <button className="quiet-button guide-cancel" type="button" onClick={() => onClose(null)}>Cancel</button>
          </div>
        </>}
      </div>}

      {stage === "creating" && <button className="guide-leave" type="button" onClick={() => { session.current?.dispose(); session.current = null; setStage("intro"); }}>
        ← Back
      </button>}
    </div>
  </div>, document.body);
}
