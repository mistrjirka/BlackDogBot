# BlackDogBot Code Style Guide

This project maintains a strict coding style to ensure consistency across the daemon and its various components. All contributors must follow these guidelines.

## Naming Conventions

| Item | Visibility | Case | Prefix | Suffix | Example |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Class Names** | All | PascalCase | | | `export class MyClass {}` |
| **Service Names** | All | PascalCase | | `Service` | `export class JobExecutorService {}` |
| **Agent Names** | All | PascalCase | | `Agent` | `export class MainAgent {}` |
| **Interface Names**| All | PascalCase | `I` | | `export interface IMessage {}` |
| **Abstract Classes**| All | PascalCase | | `Base` | `export abstract class BaseAgentBase {}` |
| **Method Names** | All | camelCase | | | `public doSomething(): void` |
| **Async Methods** | All | camelCase | | `Async` | `public async fetchAsync(): Promise<void>` |
| **Private Members** | private | camelCase | `_` | | `private _isActive: boolean;` |
| **Public Properties**| public | camelCase | | | `public status: string;` |
| **Constants** | static | PascalCase | `_` (priv) | | `private static readonly _Timeout = 1000;` |
| **File Names** | N/A | kebab-case | | `.role.ts` | `config.service.ts`, `add-node.tool.ts` |

## Code Organization (Regions)

Use `//#region` and `//#endregion` to structure large classes and files.

**Allowed Regions:**
- Data members (Const, ReadOnly, Fields)
- Properties / Public members
- Constructors
- Public methods
- Private methods (including Protected)
- Getters and Setters

Example:
```typescript
export class ExampleService {
  //#region Data members
  private _count: number = 0;
  //#endregion Data members

  //#region Public methods
  public increment(): void { ... }
  //#endregion Public methods
}
```

## Typing and Async

- **Explicit Return Types**: Every function and method must have an explicit return type definition.
- **No Implicit `any`**: Avoid `any` at all costs. Use `unknown` or specific interfaces.
- **Async Suffix**: All methods returning a `Promise` **must** end with the `Async` suffix.
- **Top-level await**: Allowed only in entry points; prefer `async mainAsync()` pattern.

## Service Patterns

- **Singletons**: Most services are singletons. Use a `private static _instance` pattern if needed, though they are typically managed by the main daemon lifecycle.
- **Property Initialization**: Define types in the class body, but initialize them in the `constructor` or an `initializeAsync` method.

## Logging & Errors

- **LoggerService**: Never use `console.log`. Use `LoggerService.getInstance().info(...)`.
- **Structured Errors**: Use `IAiErrorDetails` and utility helpers to handle LLM-specific errors.
- **Try-Catch**: Use `error: unknown` and type-guards to handle exceptions.

## Testing

- **Vitest**: Use the `describe`, `it`, `expect` pattern.
- **Isolation**: Use temporary directories (`fs.mkdtemp`) for file-system-dependent tests.
- **Service Resets**: Call `resetSingletons()` in `beforeEach` to ensure a clean state.
- **No Truncation**: Never pipe test output through `head` or `tail`.
