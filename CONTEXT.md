# Recipes

A personal recipe system that turns unstructured recipes (text, web pages, photos, video) into rich structured recipes that can be saved, searched, cooked from, and eventually shopped for.

## Language

### People

**User**:
A person who owns recipes. Every Recipe belongs to exactly one User and is visible only to that User.
_Avoid_: Account, owner, household

### Recipes

**Recipe**:
A structured, saved recipe belonging to a User, made of Ingredient Lines and Steps and editable after it is created.
_Avoid_: Card, entry, dish

**Step**:
One ordered instruction in a Recipe.
_Avoid_: Direction, instruction, method

**Section**:
A self-contained part of a Recipe with its own Ingredient Lines and Steps, such as the "Butter mustard pan sauce" in a salmon Recipe. A Recipe has at least one Section, and a Section's name can be empty when the Recipe has only one part.
_Avoid_: Group, component, part, sub-recipe

**Yield**:
What a Recipe makes, as an amount and a thing, such as "4 servings" or "1 loaf".
_Avoid_: Servings, portions, makes

**Source**:
The original unstructured input a Recipe was generated from, such as pasted text, a web page, a photo, or a video. It is kept verbatim and never changed by edits to the Recipe.
_Avoid_: Original, raw recipe, input

### Ingestion

**Ingestion**:
One attempt to turn a Source into a Recipe, which either succeeds or fails. A Source may be ingested more than once, and each successful Ingestion produces a new Recipe.
_Avoid_: Import, parse, scrape

**Ingestion Method**:
A kind of Source that Ingestion accepts, such as pasted text, a web page URL, a photo, or a video.
_Avoid_: Importer, adapter, connector

**Provenance**:
The record of how a Recipe's structured data was generated: which Source it came from and which models produced it.
_Avoid_: Metadata, lineage, audit

### Ingredients

**Ingredient**:
A canonical food item named bare, such as "red onion" (distinct from "yellow onion") or "peas" (for "frozen peas"). Variety distinguishes Ingredients; Preparation never does. Ingredients are shared by all Users, and one first seen during Ingestion is added for everyone.
_Avoid_: Item, food, product

**Alias**:
Another name for the same Ingredient, such as "scallion" for "green onion". An Ingredient has one name and any number of Aliases.
_Avoid_: Synonym, alternate name

**Ingredient Line**:
One line of a Section's ingredients as written, such as "1 (14 oz) can diced tomatoes", shown exactly in its original wording. Alongside the wording it may carry an amount, a Unit, a Package Size, and the one Ingredient it uses. A line with no Ingredient is unmatched, because it is not food or names something too generic to buy, such as "chicken".
_Avoid_: Recipe ingredient, line item

**Preparation**:
Words in an Ingredient Line describing how or in what form an Ingredient is used, such as "diced", "shredded", "frozen", or "dried". It stays in the line's wording and never changes which Ingredient the line uses.
_Avoid_: Modifier, prep, cut, state

**Unit**:
A measure from the system's fixed list that an Ingredient Line's amount is counted in, such as cup, tablespoon, gram, clove, can, pinch, or handful.
_Avoid_: Measure, measurement

**Package Size**:
The size of the package an Ingredient Line's Unit refers to, such as the "14 oz" in "1 (14 oz) can".
_Avoid_: Container size, can size

**Grocery List**:
A shopping list of Ingredients drawn from one or more Recipes.
_Avoid_: Shopping list, cart
