import type { Recipe } from '@recipes/core'
import { Button } from '@/components/ui/button'

type AppProps = {
  recipes: Recipe[]
}

export function App({ recipes }: AppProps) {
  return (
    <main className="min-h-svh bg-[radial-gradient(circle_at_top_left,var(--color-muted),transparent_34rem)] px-6 py-10 text-foreground">
      <section className="mx-auto flex min-h-[calc(100svh-5rem)] w-full max-w-5xl items-center">
        <div className="w-full rounded-3xl border bg-card p-8 shadow-sm sm:p-12 lg:p-16">
          <p className="mb-4 text-sm font-medium tracking-[0.24em] text-muted-foreground uppercase">
            Recipe App
          </p>
          <h1 className="max-w-3xl text-5xl leading-none font-semibold tracking-tight text-balance sm:text-7xl lg:text-8xl">
            Recipes
          </h1>
          <p className="mt-6 max-w-2xl text-lg leading-8 text-muted-foreground sm:text-xl">
            A clean starting point for collecting and sharing recipes.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Button size="lg">Start with recipes</Button>
            <Button variant="outline" size="lg">
              View project setup
            </Button>
          </div>
          <ul className="mt-8 list-disc space-y-2 pl-5 text-sm font-medium text-muted-foreground">
            {recipes.map((recipe) => (
              <li key={recipe.id}>{recipe.title}</li>
            ))}
          </ul>
        </div>
      </section>
    </main>
  )
}
