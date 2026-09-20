/**
 * The selfie step: Avaturn turns a phone photograph into a rigged humanoid GLB,
 * entirely in the browser.
 *
 * Their SDK renders its own capture-and-adjust flow into an element we give it,
 * and hands back a URL to the finished avatar when the person is done. We fetch
 * that GLB once, take a portrait off it, and keep the bytes locally; nothing
 * about the photograph touches this app's server.
 *
 * Point VITE_AVATURN_URL at your own project — avaturn.me, Developers, Create
 * Project, then copy the subdomain. The default below is Avaturn's public demo,
 * which is rate limited and not something to demo on.
 */
import { PerspectiveCamera, Scene, WebGLRenderer, AmbientLight, DirectionalLight, Vector3, Box3, SRGBColorSpace, Color, Quaternion } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Rig } from "./rig.ts";
import { standing } from "./pose.ts";
import { env } from "./env.ts";

/**
 * Avaturn's own shared demo project. It is somebody else's: it asks people to
 * sign in, it is rate limited across everyone pointed at it, and it is not
 * something to demo on. Set VITE_AVATURN_URL and none of that applies.
 */
export const AVATURN_DEMO = "https://demo.avaturn.dev";

export const AVATURN_URL: string = env.VITE_AVATURN_URL || AVATURN_DEMO;

interface AvaturnSdk {
  init(container: HTMLElement, options: { url: string }): Promise<void>;
  on(event: "export", handler: (data: { url?: string }) => void): void;
  destroy?(): void;
}

let sdkModule: Promise<{ AvaturnSDK: new () => AvaturnSdk }> | null = null;

/** The SDK ships as an ES module on a CDN and has no npm build we can bundle,
 * so it is fetched at the moment the step opens rather than on every page. */
function loadSdk() {
  const url = "https://cdn.jsdelivr.net/npm/@avaturn/sdk/dist/index.js";
  sdkModule ??= import(/* @vite-ignore */ url) as Promise<{ AvaturnSDK: new () => AvaturnSdk }>;
  return sdkModule;
}

export interface AvaturnSession {
  /** Resolves with the exported GLB's URL once the person finishes. */
  exported: Promise<string>;
  dispose(): void;
}

/** Put the creator inside `container`. Resolves when the SDK is on screen. */
export async function openAvaturn(container: HTMLElement, url = AVATURN_URL): Promise<AvaturnSession> {
  const { AvaturnSDK } = await loadSdk();
  const sdk = new AvaturnSDK();
  let settle: ((glbUrl: string) => void) | null = null;
  let fail: ((error: Error) => void) | null = null;
  const exported = new Promise<string>((resolve, reject) => { settle = resolve; fail = reject; });
  sdk.on("export", (data) => {
    if (data.url) settle?.(data.url);
    else fail?.(new Error("Avaturn finished without an avatar"));
  });
  await sdk.init(container, { url });
  return {
    exported,
    dispose() {
      try { sdk.destroy?.(); } catch { /* the SDK is already gone */ }
      container.replaceChildren();
    },
  };
}

/** Fetch the finished avatar, and pull a stable id out of its URL. */
export async function downloadAvatar(glbUrl: string, signal?: AbortSignal): Promise<{ glb: ArrayBuffer; avatarId: string }> {
  const response = await fetch(glbUrl, { signal });
  if (!response.ok) throw new Error(`The avatar could not be downloaded (${response.status})`);
  const glb = await response.arrayBuffer();
  const segments = glbUrl.split(/[/?#]/).filter(Boolean);
  const avatarId = segments.find((s) => s.length > 20 && !s.includes(".")) ?? segments.pop()?.replace(/\.glb$/, "") ?? "avatar";
  return { glb, avatarId };
}

/**
 * A head-and-shoulders JPEG of the avatar, rendered offscreen.
 *
 * Posed standing first. Every one of these arrives in a T-pose, and a portrait
 * of someone holding their arms straight out reads as an error rather than a
 * person.
 */
export async function renderPortrait(glb: ArrayBuffer): Promise<string> {
  const width = 320, height = 400;
  let renderer: WebGLRenderer | null = null;
  try {
    const gltf = await new GLTFLoader().parseAsync(glb, "");
    const avatar = gltf.scene;
    const rig = new Rig(avatar);
    if (rig.usable) {
      avatar.updateMatrixWorld(true);
      rig.apply(standing(), new Quaternion());
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    renderer = new WebGLRenderer({ canvas, antialias: true });
    renderer.setSize(width, height, false);
    renderer.outputColorSpace = SRGBColorSpace;

    const scene = new Scene();
    scene.background = new Color(0x14181f);
    scene.add(avatar);
    scene.add(new AmbientLight(0xffffff, 1.5));
    const key = new DirectionalLight(0xffffff, 2.2);
    key.position.set(0.6, 1.8, 2);
    scene.add(key);
    const fill = new DirectionalLight(0xffffff, 0.7);
    fill.position.set(-1.6, 0.6, 1);
    scene.add(fill);

    // Frame the head from the skeleton where there is one, and from the top of
    // the bounding box where there is not.
    avatar.updateMatrixWorld(true);
    const head = rig.get("Head");
    const eyes = new Vector3();
    if (head) head.getWorldPosition(eyes);
    else {
      const bounds = new Box3().setFromObject(avatar);
      eyes.set((bounds.min.x + bounds.max.x) / 2, bounds.max.y - 0.14, (bounds.min.z + bounds.max.z) / 2);
    }
    const camera = new PerspectiveCamera(26, width / height, 0.01, 20);
    camera.position.set(eyes.x, eyes.y - 0.05, eyes.z + 0.72);
    camera.lookAt(eyes.x, eyes.y + 0.04, eyes.z);
    renderer.render(scene, camera);
    return canvas.toDataURL("image/jpeg", 0.88);
  } catch {
    // A portrait is decoration. Losing it must never lose the guide.
    return "";
  } finally {
    // dispose() frees three.js's own objects but leaves the WebGL context
    // alive. A browser allows only a handful at once and force-loses the
    // oldest past that — which, with a world open, is the world's. Every
    // portrait would otherwise leak one.
    renderer?.forceContextLoss();
    renderer?.dispose();
  }
}
