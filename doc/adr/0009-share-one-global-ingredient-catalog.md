# 0009. Share one global Ingredient catalog across all Users

Date: 2026-11-16

## Status

Accepted

## Context

Recipes belong to a User, and the system is designed for more than one User even though it has one today. Ingredients are what make Ingredient matching, search, and future Grocery Lists work, so their ownership shapes everything downstream. The alternative was a per-User catalog, which keeps one User's naming from affecting another but makes "the same onion" a different Ingredient for every User.

## Decision

Keep a single global Ingredient catalog shared by all Users. Recipes and their Ingredient Lines stay owned by a User. An Ingredient first seen during Ingestion is created in the global catalog and is visible to everyone. Ingredient identity is shelf-level: "red onion" and "yellow onion" are distinct Ingredients, while Preparations such as "diced" belong to the Ingredient Line, never to the Ingredient.

## Consequences

- One User's Ingestion can add Ingredients that every User sees. Matching must guard against near-duplicates, because it is the main way the shared catalog degrades.
- Merging or correcting Ingredients changes them for every Recipe that uses them, across all Users.
- Anything that must not leak between Users, such as deployed-environment test data, must avoid creating Ingredients.
