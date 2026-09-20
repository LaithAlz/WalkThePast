import { useEffect, useRef, useState } from "react";
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
  const mapRef = useRef<maplibregl.Map | null>(null);
  const [mapError, setMapError] = useState(false);

  useEffect(() => {
    if (!mapHost.current || !entity.coordinates) return;
    setMapError(false);
    const [longitude, latitude] = entity.coordinates;
    const map = new maplibregl.Map({
      container: mapHost.current,
      // OpenFreeMap serves full OpenStreetMap-derived vector data rather than
      // MapLibre's deliberately sparse demonstration tiles.
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [longitude - 75, Math.max(-55, Math.min(55, latitude * 0.45))],
      zoom: 1.15,
      pitch: 0,
      bearing: -18,
      maxPitch: 70,
      attributionControl: false,
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true, showCompass: true }), "bottom-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");

    const pin = document.createElement("button");
    pin.className = "portal-pin";
    pin.type = "button";
    pin.setAttribute("aria-label", `${entity.label} map location`);
    pin.innerHTML = "<span></span><i></i>";
    const popup = new maplibregl.Popup({ offset: 34, closeButton: false }).setHTML(`<strong>${escapeHtml(entity.label)}</strong><small>Mapped location</small>`);
    new maplibregl.Marker({ element: pin, anchor: "bottom" }).setLngLat(entity.coordinates).setPopup(popup).addTo(map);

    map.once("style.load", () => {
      map.setProjection({ type: "globe" });
      map.flyTo({ center: entity.coordinates!, zoom: 2.65, pitch: 18, bearing: 0, duration: 2800, essential: true });
    });
    map.on("error", (event) => {
      if (event.error) setMapError(true);
    });
    return () => { mapRef.current = null; map.remove(); };
  }, [entity]);

  const focusLocation = () => {
    mapRef.current?.flyTo({ center: entity.coordinates!, zoom: entity.kind === "site" ? 13 : 8, pitch: 48, duration: 1800, essential: true });
  };

  const coordinates = entity.coordinates ? formatCoordinates(entity.coordinates) : "Location unavailable";

  return (
    <section className={`knowledge-portal is-${phase}`} aria-label={`Map of ${entity.label}`}>
      {snapshot && <img className="portal-snapshot" src={snapshot} alt="Frozen view of the historical reconstruction" />}
      <div className="portal-map-shell"><div ref={mapHost} className="portal-map" /></div>
      <header className="portal-header">
        <button className="portal-back" type="button" onClick={onBack}>← Back to world</button>
      </header>
      <aside className="portal-location-card" aria-label={`About ${entity.label}`}>
        <p className="portal-kicker"><span />{entity.kind} · mapped location</p>
        <h2>{entity.label}</h2>
        <p className="portal-coordinates">{coordinates}</p>
        <p className="portal-description">{entity.summary}</p>
        <div className="portal-location-actions">
          <button type="button" onClick={focusLocation}>Explore this area <span>⌖</span></button>
          <a href={entity.articleUrl} target="_blank" rel="noreferrer">Read reference <span>↗</span></a>
        </div>
        {mapError && <p className="portal-map-error" role="status">Some live map detail could not be loaded. The pin still marks the recorded coordinates.</p>}
      </aside>
      <div className="portal-hint">DRAG TO EXPLORE · SCROLL TO ZOOM · THE 3D WORLD IS PAUSED</div>
    </section>
  );
}

function formatCoordinates([longitude, latitude]: [number, number]): string {
  return `${Math.abs(latitude).toFixed(4)}° ${latitude >= 0 ? "N" : "S"} · ${Math.abs(longitude).toFixed(4)}° ${longitude >= 0 ? "E" : "W"}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]!);
}
