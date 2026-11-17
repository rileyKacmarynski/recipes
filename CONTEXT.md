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
A named group of Ingredient Lines or Steps within a Recipe, such as "For the sauce".
_Avoid_: Group, component, part

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
A canonical food item at the level you would pick off the shelf, such as "red onion" (distinct from "yellow onion"). Ingredients are shared by all Users; one first seen during Ingestion is added for everyone.
_Avoid_: Item, food, product

**Ingredient Line**:
One Recipe's use of an Ingredient, as written in the Recipe, such as "1 ½ cups finely diced red onion". It keeps its original wording alongside its amount, unit, Ingredient, and Preparations.
_Avoid_: Recipe ingredient, line item

**Preparation**:
How an Ingredient is readied for one Ingredient Line, such as "diced", "shredded", or "quartered". It belongs to the line, never to the Ingredient.
_Avoid_: Modifier, prep, cut

**Grocery List**:
A shopping list of Ingredients drawn from one or more Recipes.
_Avoid_: Shopping list, cart
