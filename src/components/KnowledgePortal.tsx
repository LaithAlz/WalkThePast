import { useEffect, useRef } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { HistoricalEntity } from "../historian/entities";

type Props = {
  entity: HistoricalEntity;
  snapshot: string | null;
  phase: "entering" | "active" | "leaving";
  onBack: () => void;
};

export function KnowledgePortal({ entity, snapshot, phase, onBack }: Props) {
  const mapHost = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!mapHost.current || !entity.coordinates) return;
    const map = new maplibregl.Map({
      container: mapHost.current,
      style: "https://demotiles.maplibre.org/style.json",
      center: entity.coordinates,
      zoom: entity.kind === "site" ? 15 : 8,
      pitch: 20,
      bearing: 0,
      attributionControl: false,
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");
    new maplibregl.Marker({ color: "#f2a93b" }).setLngLat(entity.coordinates).setPopup(new maplibregl.Popup({ offset: 28 }).setText(entity.label)).addTo(map);
    map.once("load", () => {
      map.setProjection({ type: "globe" });
      map.flyTo({ center: entity.coordinates!, zoom: 2.25, duration: 2200, essential: true });
    });
    return () => map.remove();
  }, [entity]);

  return (
    <section className={`knowledge-portal is-${phase}`} aria-label={`Map of ${entity.label}`}>
      {snapshot && <img className="portal-snapshot" src={snapshot} alt="Frozen view of the historical reconstruction" />}
      <div className="portal-map-shell"><div ref={mapHost} className="portal-map" /></div>
      <header className="portal-header">
        <button className="portal-back" type="button" onClick={onBack}>← Back to world</button>
        <div><span>LOCATION</span><strong>{entity.label}</strong></div>
      </header>
      <div className="portal-hint">DRAG TO EXPLORE · SCROLL TO ZOOM · THE 3D WORLD IS PAUSED</div>
    </section>
  );
}
