# Kit=Code by KitKat Vietnam

The source of [`@kitkatvn/nghixahoi`](https://www.npmjs.com/package/@kitkatvn/nghixahoi), the Kit=Code tracker: the command
`nghixahoi`, which counts your coding activity on your own computer for the Kit=Code campaign at
[nghixahoi.vn](https://nghixahoi.vn/).

This repository holds the tracking logic, published so that anyone can read what Kit=Code counts and what it keeps, and the files
that build and release the npm package. The package's own README is [`packages/nghixahoi-cli/README.md`](packages/nghixahoi-cli/README.md).

## What is here

- `packages/nghixahoi-cli/`: the CLI as npm ships it (`bin/`, `src/`, its README and licence), and the scripts that lint and
  release it.
- `deploy/production/`: the domain the released CLI opens and allows, and the public half of the key it checks the campaign's
  signed answers with.
- `.github/workflows/`: the release. A tag `cli-v<version>` packs the tarball from the tagged commit and stages it on npm, where
  a maintainer approves it with two-factor authentication; npm records the commit and workflow it was built from (provenance).

## Releases

Each version on npm is built here, from a tagged commit, by `.github/workflows/release.yml`. Nobody publishes by hand.
