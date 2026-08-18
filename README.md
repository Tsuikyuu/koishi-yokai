# Yokai

Yokai is a bionic group member framework built as a nested Koishi/Yakumo monorepo.

## Workspace

- `packages/yokai`: `@yokai/koishi-plugin-yokai`
- `docs/yokai-design.md`: architecture and product design

The repository can be developed independently or placed under a Koishi application's `external` directory. Yakumo discovers its nested workspaces from the root `package.json`.

## Development

From this repository:

```sh
yarn
yarn build
```

From the containing Koishi application:

```sh
yarn workspace @root/yokai build
```
