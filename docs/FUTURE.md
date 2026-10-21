# Future features

The MVP ships exactly one real model (fal `minimax/h3-max/image-to-video`)
plus a mock. The extension points below already exist; the feature screens
do not.

## Adding a second model

The film editor's domain logic doesn't change. A new model needs:

1. **A descriptor** in `shared/models.ts`. It declares `key`, `providerId`,
   `modelId`, `label`, the duration range and default, the resolutions,
   whether seeds are supported, accepted image extensions, and
   `nativeControls` (structured controls the model actually supports; empty
   for now). The UI builds its settings controls from the descriptor alone.
2. **Adapter support.** Either extend an existing provider (for another fal
   endpoint, add a mapping in `providers/fal.ts`'s `buildRequest` keyed by
   `modelId`), or add a new file implementing `GenerationProvider`
   (`providers/types.ts`):
   - `unavailableReason()`: for example, missing credentials.
   - `supports(model)` and `validate(model, input)`: provider-specific checks
     on top of the descriptor's generic `validateSettings`.
   - `uploadSource`, `submit`, `status`, `result`, `download`.
   - Error classification: `transient` (safe to repeat a read), `permanent`,
     or `ambiguous` (a submit may have been accepted). Submits must not retry
     on their own.
   - `submit` returns the exact request body it sent, without credentials, so
     it can be stored on the job.
3. **Registration** in `server/app.ts`, so jobs created with it keep polling
   regardless of later configuration.
4. **Model selection UI.** Replace the single active model with a per-film or
   per-generation choice (`GenerateBody.modelKey`). Jobs already persist
   `providerId`, `modelKey` and `modelId`, and the worker looks providers and
   models up by those stored values. Changing configuration therefore never
   redirects polling of existing requests.

Before implementing any request field, verify it against the provider's
current API documentation. Never send undocumented fields.

## Motion controls

Keep two different things apart.

- **Text instructions.** A preset such as “slow push-in” or “orbit left” can
  only *add text* to the prompt. It must be presented as a suggestion to the
  model, not as deterministic camera control, and it works the same way on
  every text-guided model.
- **Native structured controls.** These are parameters a specific model
  documents (for example, a camera-path or motion-strength field). Only list
  them in that model's descriptor `nativeControls`, map them in that model's
  adapter, and show them only when the selected model declares them. Don't
  assume a shared "strength" scale across providers.

The current endpoint has no such controls. Shotloom sends no
`motion_strength`, camera, guidance, or negative-prompt fields.

When motion settings are added, store both of these on each job:

- **The user's intent**, for example
  `{ preset: "push-in", strength: "subtle", source: "text" }`.
- **The exact provider request** (already stored as `providerRequest`).

A natural place for a text preset is a prompt-block-like segment that
`composePrompt` places after the shared blocks, so the preview shows exactly
what is sent.

## Deferred features

These are out of scope for this version:

- World Builder: navigable maps, generated frame chaining, movement prompts
- Advanced audio: reverb, low-pass, separate effects routing
- Finder or Explorer sync during playback
- Browser uploads (files go in via the file manager for now)
- Image generation and text-only video generation
- Multitrack editing, transitions, repeated use of one clip on the timeline
- Accounts, cloud sync, collaboration, billing, hosted deployment, and a
  plugin marketplace

Possible small improvements:

- Show remote queue position.
- Cancel a remote job, if a provider documents cancellation and its billing
  effect.
- Add per-clip volume.
- Generate keyframe thumbnails server-side, so browsers without H.264 still
  show frames.
