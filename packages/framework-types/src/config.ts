import {
  ReducerMetadata,
  MigrationMetadata,
  EntityMetadata,
  RoleMetadata,
  CommandMetadata,
  ProjectionMetadata,
  ReadModelMetadata,
  EventHandlerInterface,
  ScheduledCommandMetadata,
  EventMetadata,
} from './concepts'
import { ProviderLibrary } from './provider'
import { Level } from './logger'
import * as path from 'path'
import { RocketDescriptor } from './rocket-descriptor'
import { CommandHandlerReturnTypeMetadata } from './concepts/command-handler-metadata'

/**
 * Class used by external packages that needs to get a representation of
 * the booster config. Used mainly for vendor-specific deployment packages
 */
export class BoosterConfig {
  public logLevel: Level = Level.debug
  private _provider?: ProviderLibrary
  public providerPackage?: string
  public rockets?: Array<RocketDescriptor>
  public appName = 'new-booster-app'
  public assets?: Array<string>
  public readonly subscriptions = {
    maxConnectionDurationInSeconds: 7 * 24 * 60 * 60, // 7 days
    maxDurationInSeconds: 2 * 24 * 60 * 60, // 2 days
  }
  private _userProjectRootPath?: string
  public readonly codeRelativePath: string = 'dist'
  public readonly eventDispatcherHandler: string = path.join(this.codeRelativePath, 'index.boosterEventDispatcher')
  public readonly serveGraphQLHandler: string = path.join(this.codeRelativePath, 'index.boosterServeGraphQL')
  public readonly scheduledTaskHandler: string = path.join(
    this.codeRelativePath,
    'index.boosterTriggerScheduledCommand'
  )
  public readonly notifySubscribersHandler: string = path.join(this.codeRelativePath, 'index.boosterNotifySubscribers')

  public readonly events: Record<EventName, EventMetadata> = {}
  public readonly entities: Record<EntityName, EntityMetadata> = {}
  public readonly reducers: Record<EventName, ReducerMetadata> = {}
  public readonly commandHandlers: Record<CommandName, CommandMetadata> = {}
  public readonly commandHandlerReturnTypes: Record<CommandName, CommandHandlerReturnTypeMetadata> = {}
  public readonly eventHandlers: Record<EventName, Array<EventHandlerInterface>> = {}
  public readonly readModels: Record<ReadModelName, ReadModelMetadata> = {}
  public readonly projections: Record<EntityName, Array<ProjectionMetadata>> = {}
  public readonly readModelSequenceKeys: Record<EntityName, string> = {}
  public readonly roles: Record<RoleName, RoleMetadata> = {}
  public readonly migrations: Record<ConceptName, Map<Version, MigrationMetadata>> = {}
  public readonly scheduledCommandHandlers: Record<ScheduledCommandName, ScheduledCommandMetadata> = {}

  /** Environment variables set at deployment time on the target lambda functions */
  public readonly env: Record<string, string> = {}

  private _tokenVerifier?: TokenVerifier

  public constructor(public readonly environmentName: string) {}

  public get resourceNames(): ResourceNames {
    if (this.appName.length === 0) throw new Error('Application name cannot be empty')
    const applicationStackName = this.appName + '-app'
    return {
      applicationStack: applicationStackName,
      eventsStore: applicationStackName + '-events-store',
      subscriptionsStore: applicationStackName + '-subscriptions-store',
      connectionsStore: applicationStackName + '-connections-store',
      forReadModel(readModelName: string): string {
        return applicationStackName + '-' + readModelName
      },
    }
  }

  /**
   * Returns the name of the ReadModel from the name of its resouce (normally, a table)
   * @param resourceName
   */
  public readModelNameFromResourceName(resourceName: string): string {
    const resourceNamePrefixRegex = new RegExp(`^${this.resourceNames.applicationStack}-`)
    return resourceName.replace(resourceNamePrefixRegex, '')
  }

  /**
   * This is a convenience property to easily check if the application has defined any roles.
   * Only in that case we will create a user pool and an authorization API.
   * If there are no roles defined, it means that all app endpoints are public and users
   * won't be registered (they are all anonymous)
   */
  public get thereAreRoles(): boolean {
    return Object.entries(this.roles).length > 0
  }

  public currentVersionFor(className: string): number {
    const migrations = this.migrations[className]
    if (!migrations) {
      return 1
    }

    return Math.max(...migrations.keys())
  }

  public validate(): void {
    this.validateAllMigrations()
  }

  public get provider(): ProviderLibrary {
    if (!this._provider && this.providerPackage) {
      const rockets = this.rockets ?? []
      const provider = require(this.providerPackage)
      this._provider = provider.Provider(rockets)
    }
    if (!this._provider) throw new Error('It is required to set a valid provider runtime in your configuration files')
    return this._provider
  }

  public set provider(provider: ProviderLibrary) {
    console.warn(`
      The usage of the 'config.provider' field is deprecated,
      please use 'config.providerPackage' instead.

      For more information, check out the docs:

      https://docs.booster.cloud/chapters/05_going-deeper?id=configuration-and-environments
    `)
    this._provider = provider
  }

  public get userProjectRootPath(): string {
    if (!this._userProjectRootPath)
      throw new Error('Property "userProjectRootPath" is not set. Ensure you have called "Booster.start"')
    return this._userProjectRootPath
  }

  public set userProjectRootPath(path: string) {
    this._userProjectRootPath = path
  }

  public mustGetEnvironmentVar(varName: string): string {
    const value = process.env[varName]
    if (value == undefined) {
      throw new Error(`Missing environment variable '${varName}'`)
    }
    return value
  }

  public get tokenVerifier(): TokenVerifier | undefined {
    if (this._tokenVerifier) return this._tokenVerifier
    if (
      process.env[JWT_ENV_VARS.BOOSTER_JWT_ISSUER] &&
      process.env[JWT_ENV_VARS.BOOSTER_JWKS_URI] &&
      process.env[JWT_ENV_VARS.BOOSTER_ROLES_CLAIM]
    ) {
      return {
        issuer: process.env[JWT_ENV_VARS.BOOSTER_JWT_ISSUER] as string,
        jwksUri: process.env[JWT_ENV_VARS.BOOSTER_JWKS_URI] as string,
        rolesClaim: process.env[JWT_ENV_VARS.BOOSTER_ROLES_CLAIM] as string,
      }
    }
    return undefined
  }

  public set tokenVerifier(tokenVerifier: TokenVerifier | undefined) {
    this._tokenVerifier = tokenVerifier
  }

  private validateAllMigrations(): void {
    for (const conceptName in this.migrations) {
      this.validateConceptMigrations(conceptName, this.migrations[conceptName])
    }
  }

  private validateConceptMigrations(conceptName: string, migrations: Map<number, MigrationMetadata>): void {
    // Check that migrations are defined consecutively. In other words, there are no gaps between the version numbers
    const currentVersion = this.currentVersionFor(conceptName)
    for (let toVersion = 2; toVersion <= currentVersion; toVersion++) {
      if (!migrations.has(toVersion)) {
        throw new Error(
          `Migrations for '${conceptName}' are invalid: they are missing a migration with toVersion=${toVersion}. ` +
            `There must be a migration for '${conceptName}' for every version in the range [2..${currentVersion}]`
        )
      }
    }
  }
}

export const JWT_ENV_VARS = {
  BOOSTER_JWT_ISSUER: 'BOOSTER_JWT_ISSUER',
  BOOSTER_JWKS_URI: 'BOOSTER_JWKS_URI',
  BOOSTER_ROLES_CLAIM: 'BOOSTER_ROLES_CLAIM',
}

interface ResourceNames {
  applicationStack: string
  eventsStore: string
  subscriptionsStore: string
  connectionsStore: string
  forReadModel(entityName: string): string
}

type EntityName = string
type EventName = string
type CommandName = string
type ReadModelName = string
type RoleName = string
type ConceptName = string
type Version = number
type ScheduledCommandName = string
type TokenVerifier = {
  issuer: string
  jwksUri?: string
  publicKey?: string
  rolesClaim?: string
}
