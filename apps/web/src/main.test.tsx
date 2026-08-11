import { render, screen } from "@testing-library/react";
import { App } from "./App";

test("renders the recipes page", () => {
  render(<App />);

  expect(screen.getByRole("heading", { name: "Recipes" })).toBeInTheDocument();
});
