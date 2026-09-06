import { useState, type FormEvent } from 'react'
import type { CreateRecipe, Recipe } from '@recipes/core'
import { Button } from '@/components/ui/button'
import type { IdentityContext } from './route-context'

type AppProps = {
  createError?: string
  identity: IdentityContext
  isCreating?: boolean
  onCreateRecipe(input: CreateRecipe): Promise<unknown>
  recipes: Recipe[]
}

export function App({
  createError,
  identity,
  isCreating = false,
  onCreateRecipe,
  recipes,
}: AppProps) {
  const [title, setTitle] = useState('')

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    await onCreateRecipe({ title })
    setTitle('')
  }

  return (
    <main className="min-h-svh bg-[radial-gradient(circle_at_top_left,var(--color-muted),transparent_34rem)] px-5 py-8 text-foreground sm:px-6 sm:py-10">
      <section className="mx-auto grid w-full max-w-5xl gap-8 lg:grid-cols-[minmax(0,0.9fr)_minmax(22rem,1fr)] lg:items-start">
        <div className="rounded-3xl border bg-card p-7 shadow-sm sm:p-10">
          <p className="text-sm font-medium tracking-[0.24em] text-muted-foreground uppercase">
            Recipe App
          </p>
          <h1 className="mt-4 text-5xl leading-none font-semibold tracking-tight text-balance sm:text-7xl">
            Recipes
          </h1>
          <p className="mt-5 text-lg leading-8 text-muted-foreground">
            Save the recipes worth making again. Start with a title; details can come later.
          </p>
          <p className="mt-5 text-sm font-medium text-muted-foreground">
            Signed in as {identity.email ?? identity.subject}
          </p>
        </div>

        <div className="space-y-5">
          <form className="rounded-3xl border bg-card p-6 shadow-sm sm:p-8" onSubmit={handleSubmit}>
            <div className="space-y-2">
              <label className="text-sm font-semibold" htmlFor="recipe-title">
                Recipe title
              </label>
              <input
                className="h-12 w-full rounded-xl border border-input bg-background px-4 text-base shadow-xs outline-none transition focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40"
                disabled={isCreating}
                id="recipe-title"
                name="title"
                onChange={(event) => setTitle(event.currentTarget.value)}
                placeholder="Sunday sauce"
                required
                type="text"
                value={title}
              />
            </div>

            {createError && (
              <p className="mt-3 text-sm font-medium text-destructive" role="alert">
                {createError}
              </p>
            )}

            <Button className="mt-5 w-full sm:w-auto" disabled={isCreating} size="lg" type="submit">
              {isCreating ? 'Adding recipe...' : 'Add recipe'}
            </Button>
          </form>

          <section
            className="rounded-3xl border bg-card p-6 shadow-sm sm:p-8"
            aria-labelledby="recipe-list-heading"
          >
            <div className="flex items-baseline justify-between gap-4">
              <h2 className="text-2xl font-semibold tracking-tight" id="recipe-list-heading">
                Saved recipes
              </h2>
              <span className="text-sm font-medium text-muted-foreground">
                {recipes.length} {recipes.length === 1 ? 'recipe' : 'recipes'}
              </span>
            </div>

            {recipes.length === 0 ? (
              <div className="mt-6 rounded-2xl border border-dashed bg-muted/35 p-6">
                <p className="font-semibold">No recipes yet.</p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  Add one recipe title to make sure the full stack is saving your collection.
                </p>
              </div>
            ) : (
              <ul className="mt-6 space-y-3">
                {recipes.map((recipe) => (
                  <li
                    className="rounded-2xl border bg-background px-4 py-3 font-medium"
                    key={recipe.id}
                  >
                    {recipe.title}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </section>
    </main>
  )
}
