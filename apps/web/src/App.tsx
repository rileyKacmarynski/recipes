import type { Recipe } from "@recipes/shared";

const sampleRecipe: Recipe = {
  id: "starter",
  title: "Starter Recipe",
};

export function App() {
  return (
    <main className="page">
      <section className="hero">
        <p className="eyebrow">Recipe App</p>
        <h1>Recipes</h1>
        <p className="intro">A clean starting point for collecting and sharing recipes.</p>
        <p className="sample">Shared type loaded: {sampleRecipe.title}</p>
      </section>
    </main>
  );
}
