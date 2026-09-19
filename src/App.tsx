import { useMemo } from "react";
import { WorldCanvas } from "./components/WorldCanvas";
import { WORLDS, worldFromQuery } from "./worlds";

export default function App() {
  const world = useMemo(
    () => worldFromQuery(window.location.search) ?? WORLDS[0] ?? null,
    [],
  );

  return <WorldCanvas world={world} />;
}
