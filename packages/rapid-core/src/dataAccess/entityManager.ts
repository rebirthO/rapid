import {
  AddEntityRelationsOptions,
  CountEntityOptions,
  CountEntityResult,
  CreateEntityOptions,
  EntityFilterOperators,
  EntityFilterOptions,
  FindEntityOptions,
  FindEntityOrderByOptions,
  IRpdDataAccessor,
  RemoveEntityRelationsOptions,
  RpdDataModel,
  RpdDataModelProperty,
  UpdateEntityByIdOptions,
} from "~/types";
import { isNullOrUndefined } from "~/utilities/typeUtility";
import { mapDbRowToEntity, mapEntityToDbRow } from "./entityMapper";
import { mapPropertyNameToColumnName } from "./propertyMapper";
import { isRelationProperty } from "~/utilities/rapidUtility";
import { IRpdServer, RapidPlugin } from "~/core/server";
import { getEntityPartChanges } from "~/helpers/entityHelpers";
import { filter, find, first, forEach, isArray, isObject, keys, map, reject, uniq } from "lodash";

function convertToDataAccessOrderBy(model: RpdDataModel, orderByList?: FindEntityOrderByOptions[]) {
  if (!orderByList) {
    return orderByList;
  }

  return orderByList.map(orderBy => {
    return {
      field:  mapPropertyNameToColumnName(model, orderBy.field),
      desc: !!orderBy.desc,
    } as FindEntityOrderByOptions
  })
}

async function findEntities(
  server: IRpdServer,
  dataAccessor: IRpdDataAccessor,
  options: FindEntityOptions,
) {
  const model = dataAccessor.getModel();
  const fieldsToSelect: string[] = [];
  const relationPropertiesToSelect: RpdDataModelProperty[] = [];
  if (options.properties) {
    forEach(options.properties, (propertyCode: string) => {
      const property = model.properties.find((e) => e.code === propertyCode);
      if (!property) {
        throw new Error(
          `Collection '${model.namespace}.${model.singularCode}' does not have a property '${propertyCode}'.`,
        );
      }

      if (isRelationProperty(property)) {
        relationPropertiesToSelect.push(property);

        if (property.relation === "one" && !property.linkTableName) {
          if (!property.targetIdColumnName) {
            throw new Error(
              `'targetIdColumnName' should be configured for property '${propertyCode}' of model '${model.namespace}.${model.singularCode}'.`,
            );
          }
          fieldsToSelect.push(property.targetIdColumnName);
        }
      } else {
        fieldsToSelect.push(property.columnName || property.code);
      }
    });
  }

  const processedFilters = await replaceFiltersWithFiltersOperator(
    server,
    model,
    options.filters,
  );

  const findEntityOptions: FindEntityOptions = {
    filters: processedFilters,
    orderBy: convertToDataAccessOrderBy(model, options.orderBy),
    pagination: options.pagination,
    properties: fieldsToSelect,
  };
  const entities = await dataAccessor.find(findEntityOptions);
  if (!entities.length) {
    return entities;
  }

  const entityIds = entities.map((e) => e.id);
  if (relationPropertiesToSelect.length) {
    for (const relationProperty of relationPropertiesToSelect) {
      const isManyRelation = relationProperty.relation === "many";

      if (relationProperty.linkTableName) {
        const targetModel = server.getModel({ singularCode: relationProperty.targetSingularCode! });
        if (!targetModel) {
          continue;
        }

        if (isManyRelation) {
          const relationLinks = await findManyRelationLinksViaLinkTable(
            server,
            targetModel,
            relationProperty,
            entityIds,
          ); 

          forEach(entities, (entity: any) => {
            entity[relationProperty.code] = filter(relationLinks, (link: any) => {
              return link[relationProperty.selfIdColumnName!] == entity["id"];
            }).map(link => mapDbRowToEntity(targetModel, link.targetEntity, false));
          });
        }
      } else {
        let relatedEntities: any[];
        if (isManyRelation) {
          relatedEntities = await findManyRelatedEntitiesViaIdPropertyCode(
            server,
            model,
            relationProperty,
            entityIds,
          );
        } else {
          const targetEntityIds = uniq(
            reject(
              map(
                entities,
                (entity: any) => entity[relationProperty.targetIdColumnName!],
              ),
              isNullOrUndefined,
            ),
          );
          relatedEntities = await findOneRelatedEntitiesViaIdPropertyCode(
            server,
            model,
            relationProperty,
            targetEntityIds,
          );
        }

        const targetModel = server.getModel({
          singularCode: relationProperty.targetSingularCode!,
        });
        entities.forEach((entity) => {
          if (isManyRelation) {
            entity[relationProperty.code] = filter(
              relatedEntities,
              (relatedEntity: any) => {
                return relatedEntity[relationProperty.selfIdColumnName!] == entity.id;
              },
            ).map(item => mapDbRowToEntity(targetModel!, item, false));
          } else {
            entity[relationProperty.code] = mapDbRowToEntity(targetModel!, find(
              relatedEntities,
              (relatedEntity: any) => {
                // TODO: id property code should be configurable.
                return relatedEntity["id"] == entity[relationProperty.targetIdColumnName!];
              },
            ), false);
          }
        });
      }
    }
  }
  return entities.map(item => mapDbRowToEntity(model, item, options.keepNonPropertyFields));
}

async function findEntity(
  server: IRpdServer,
  dataAccessor: IRpdDataAccessor,
  options: FindEntityOptions,
) {
  const entities = await findEntities(server, dataAccessor, options);
  return first(entities);
}

async function findById(
  server: IRpdServer,
  dataAccessor: IRpdDataAccessor,
  id: any,
  keepNonPropertyFields: boolean = false
): Promise<any> {
  return await findEntity(server, dataAccessor, {
    filters: [
      {
        operator: "eq",
        field: "id",
        value: id,
      }
    ],
    keepNonPropertyFields,
  });
}

async function replaceFiltersWithFiltersOperator(
  server: IRpdServer,
  model: RpdDataModel,
  filters: EntityFilterOptions[] | undefined,
) {
  if (!filters || !filters.length) {
    return [];
  }

  const replacedFilters: EntityFilterOptions[] = [];
  for (const filter of filters) {
    const { operator } = filter;
    if (operator === "and" || operator === "or") {
      filter.filters = await replaceFiltersWithFiltersOperator(
        server,
        model,
        filter.filters,
      );
      replacedFilters.push(filter);
    } else if (operator === "exists" || operator === "notExists") {
      const relationProperty: RpdDataModelProperty = find(
        model.properties,
        (property: RpdDataModelProperty) => property.code === filter.field,
      );
      if (!relationProperty) {
        throw new Error(
          `Invalid filters. Property '${filter.field}' was not found in model '${model.namespace}.${model.singularCode}'`,
        );
      }
      if (!isRelationProperty(relationProperty)) {
        throw new Error(
          `Invalid filters. Filter with 'existence' operator on property '${filter.field}' is not allowed. You can only use it on an relation property.`,
        );
      }

      const relatedEntityFilters = filter.filters;
      if (!relatedEntityFilters || !relatedEntityFilters.length) {
        throw new Error(
          `Invalid filters. 'filters' must be provided on filter with 'existence' operator.`,
        );
      }


      if (relationProperty.relation === "one") {
        // Optimize when filtering by id of related entity
        if (relatedEntityFilters.length === 1) {
          const relatedEntityIdFilter = relatedEntityFilters[0];
          if (
            (relatedEntityIdFilter.operator === "eq" ||
              relatedEntityIdFilter.operator === "in") &&
            relatedEntityIdFilter.field === "id"
          ) {
            let replacedOperator: EntityFilterOperators;
            if (operator === "exists") {
              replacedOperator = relatedEntityIdFilter.operator;
            } else {
              if (relatedEntityIdFilter.operator === "eq") {
                replacedOperator = "ne";
              } else {
                replacedOperator = "notIn";
              }
            }
            replacedFilters.push({
              field: relationProperty.targetIdColumnName as string,
              operator: replacedOperator,
              value: relatedEntityIdFilter.value,
            });
            continue;
          }
        }

        const dataAccessor = server.getDataAccessor({
          singularCode: relationProperty.targetSingularCode as string,
        });
        const entities = await dataAccessor.find({
          filters: filter.filters,
          properties: ["id"],
        });
        const entityIds = map(entities, (entity: any) => entity["id"]);
        replacedFilters.push({
          field: relationProperty.targetIdColumnName as string,
          operator: operator === "exists" ? "in" : "notIn",
          value: entityIds,
        });
      } else if (!relationProperty.linkTableName) {
        // many relation without link table.
        if (!relationProperty.selfIdColumnName) {
          throw new Error(
            `Invalid filters. 'selfIdColumnName' of property '${relationProperty.code}' was not configured`,
          );
        }

        const targetEntityDataAccessor = server.getDataAccessor({
          singularCode: relationProperty.targetSingularCode as string,
        });

        const targetEntities = await targetEntityDataAccessor.find({
          filters: filter.filters,
          properties: [relationProperty.selfIdColumnName],
        });
        const selfEntityIds = map(targetEntities, (entity: any) => entity[relationProperty.selfIdColumnName!]);
        replacedFilters.push({
          field: "id",
          operator: operator === "exists" ? "in" : "notIn",
          value: selfEntityIds,
        });
      } else {
        // many relation with link table
        if (!relationProperty.selfIdColumnName) {
          throw new Error(
            `Invalid filters. 'selfIdColumnName' of property '${relationProperty.code}' was not configured`,
          );
        }

        if (!relationProperty.targetIdColumnName) {
          throw new Error(
            `Invalid filters. 'targetIdColumnName' of property '${relationProperty.code}' was not configured`,
          );
        }

        // 1. find target entities
        // 2. find links
        // 3. convert to 'in' filter
        const targetEntityDataAccessor = server.getDataAccessor({
          singularCode: relationProperty.targetSingularCode as string,
        });

        const targetEntities = await targetEntityDataAccessor.find({
          filters: filter.filters,
          properties: ['id'],
        });
        const targetEntityIds = map(targetEntities, (entity: any) => entity['id']);

        const command = `SELECT * FROM ${server.queryBuilder.quoteTable({schema: relationProperty.linkSchema, tableName: relationProperty.linkTableName!})} WHERE ${server.queryBuilder.quoteObject(relationProperty.targetIdColumnName!)} = ANY($1::int[])`;
        const params = [targetEntityIds];
        const links = await server.queryDatabaseObject(command, params);
        const selfEntityIds = links.map(link => link[relationProperty.selfIdColumnName!]);
        replacedFilters.push({
          field: "id",
          operator: operator === "exists" ? "in" : "notIn",
          value: selfEntityIds,
        });
      }
    } else {
      replacedFilters.push(filter);
    }
  }
  return replacedFilters;
}

async function findManyRelationLinksViaLinkTable(
  server: IRpdServer,
  targetModel: RpdDataModel,
  relationProperty: RpdDataModelProperty,
  entityIds: any[],
) {


  const command = `SELECT * FROM ${server.queryBuilder.quoteTable({schema: relationProperty.linkSchema, tableName: relationProperty.linkTableName!})} WHERE ${server.queryBuilder.quoteObject(relationProperty.selfIdColumnName!)} = ANY($1::int[])`;
  const params = [entityIds];
  const links = await server.queryDatabaseObject(command, params);
  const targetEntityIds = links.map(link => link[relationProperty.targetIdColumnName!]);
  const findEntityOptions: FindEntityOptions = {
    filters: [
      {
        field: "id",
        operator: "in",
        value: targetEntityIds,
      },
    ],
  };
  const dataAccessor = server.getDataAccessor({
    namespace: targetModel.namespace,
    singularCode: targetModel.singularCode,
  });
  const targetEntities = await dataAccessor.find(findEntityOptions);

  forEach(links, (link: any) => {
    link.targetEntity = find(targetEntities, (e: any) => e["id"] == link[relationProperty.targetIdColumnName!]);
  });

  return links;
}

function findManyRelatedEntitiesViaIdPropertyCode(
  server: IRpdServer,
  model: RpdDataModel,
  relationProperty: RpdDataModelProperty,
  entityIds: any[],
) {
  const findEntityOptions: FindEntityOptions = {
    filters: [
      {
        field: relationProperty.selfIdColumnName as string,
        operator: "in",
        value: entityIds,
      },
    ],
  };
  const dataAccessor = server.getDataAccessor({
    singularCode: relationProperty.targetSingularCode as string,
  });

  return dataAccessor.find(findEntityOptions);
}

function findOneRelatedEntitiesViaIdPropertyCode(
  server: IRpdServer,
  model: RpdDataModel,
  relationProperty: RpdDataModelProperty,
  targetEntityIds: any[],
) {
  const findEntityOptions: FindEntityOptions = {
    filters: [
      {
        field: "id",
        operator: "in",
        value: targetEntityIds,
      },
    ],
  };
  const dataAccessor = server.getDataAccessor({
    singularCode: relationProperty.targetSingularCode as string,
  });

  return dataAccessor.find(findEntityOptions);
}

async function createEntity(
  server: IRpdServer,
  dataAccessor: IRpdDataAccessor,
  options: CreateEntityOptions,
) {
  const model = dataAccessor.getModel();
  const { entity } = options;

  const oneRelationPropertiesToCreate: RpdDataModelProperty[] = [];
  const manyRelationPropertiesToCreate: RpdDataModelProperty[] = [];
  keys(entity).forEach((propertyCode) => {
    const property = model.properties.find((e) => e.code === propertyCode);
    if (!property) {
      // Unknown property
      return;
    }

    if (isRelationProperty(property)) {
      if (property.relation === "many") {
        manyRelationPropertiesToCreate.push(property);
      } else {
        oneRelationPropertiesToCreate.push(property);
      }
    }
  })

  const row = mapEntityToDbRow(model, entity);

  // save one-relation properties
  for (const property of oneRelationPropertiesToCreate) {
    const fieldValue = entity[property.code];
    if (isObject(fieldValue)) {
      if (!fieldValue["id"]) {
        const targetDataAccessor = server.getDataAccessor({
          singularCode: property.targetSingularCode!,
        });
        const targetEntity = fieldValue;
        const newTargetEntity = await createEntity(server, targetDataAccessor, {
          entity: targetEntity,
        });
        row[property.targetIdColumnName!] = newTargetEntity["id"];
      } else {
        row[property.targetIdColumnName!] = fieldValue["id"];
      }
    } else {
      // fieldValue is id;
      row[property.targetIdColumnName!] = fieldValue;
    }
  }

  const newRow = await dataAccessor.create(row);
  const newEntity = mapDbRowToEntity(model, newRow, false);

  // save many-relation properties
  for (const property of manyRelationPropertiesToCreate) {
    newEntity[property.code] = [];

    const targetDataAccessor = server.getDataAccessor({
      singularCode: property.targetSingularCode!,
    });

    const relatedEntitiesToBeSaved = entity[property.code];
    if (!isArray(relatedEntitiesToBeSaved)) {
      throw new Error(`Value of field '${property.code}' should be an array.`);
    }

    for (const relatedEntityToBeSaved of relatedEntitiesToBeSaved) {
      let relatedEntityId: any;
      if (isObject(relatedEntityToBeSaved)) {
        relatedEntityId = relatedEntityToBeSaved["id"];
        if (!relatedEntityId) {
          // related entity is to be created
          const targetEntity = relatedEntityToBeSaved;
          if (!property.linkTableName) {
            targetEntity[property.selfIdColumnName!] = newEntity.id;
          }
          const newTargetEntity = await createEntity(server, targetDataAccessor, {
            entity: targetEntity,
          });

          if (property.linkTableName) {
            const command = `INSERT INTO ${server.queryBuilder.quoteTable({schema:property.linkSchema, tableName: property.linkTableName})} (${server.queryBuilder.quoteObject(property.selfIdColumnName!)}, ${property.targetIdColumnName}) VALUES ($1, $2) ON CONFLICT DO NOTHING;`
            const params = [newEntity.id, newTargetEntity.id];
            await server.queryDatabaseObject(command, params);
          }

          newEntity[property.code].push(newTargetEntity);
        } else {
          // related entity is existed
          const targetEntity = await targetDataAccessor.findById(relatedEntityId);
          if (!targetEntity) {
            throw new Error(`Entity with id '${relatedEntityId}' in field '${property.code}' is not exists.`)
          }

          if (property.linkTableName) {
            const command = `INSERT INTO ${server.queryBuilder.quoteTable({schema:property.linkSchema, tableName: property.linkTableName})} (${server.queryBuilder.quoteObject(property.selfIdColumnName!)}, ${property.targetIdColumnName}) VALUES ($1, $2) ON CONFLICT DO NOTHING;`
            const params = [newEntity.id, relatedEntityId];
            await server.queryDatabaseObject(command, params);
          } else {
            await targetDataAccessor.updateById(targetEntity.id, {[property.selfIdColumnName!]: newEntity.id});
            targetEntity[property.selfIdColumnName!] = newEntity.id;
          }
          newEntity[property.code].push(targetEntity);
        }
      } else {
        // fieldValue is id
        relatedEntityId = relatedEntityToBeSaved
        const targetEntity = await targetDataAccessor.findById(relatedEntityId);
        if (!targetEntity) {
          throw new Error(`Entity with id '${relatedEntityId}' in field '${property.code}' is not exists.`)
        }

        if (property.linkTableName) {
          const command = `INSERT INTO ${server.queryBuilder.quoteTable({schema:property.linkSchema, tableName: property.linkTableName})} (${server.queryBuilder.quoteObject(property.selfIdColumnName!)}, ${property.targetIdColumnName}) VALUES ($1, $2) ON CONFLICT DO NOTHING;`
          const params = [newEntity.id, relatedEntityId];
          await server.queryDatabaseObject(command, params);
        } else {
          await targetDataAccessor.updateById(targetEntity.id, {[property.selfIdColumnName!]: newEntity.id});
          targetEntity[property.selfIdColumnName!] = newEntity.id;
        }

        newEntity[property.code].push(targetEntity);
      }
    }
  }


  return newEntity;
}

async function updateEntityById(
  server: IRpdServer,
  dataAccessor: IRpdDataAccessor,
  options: UpdateEntityByIdOptions,
  plugin?: RapidPlugin
) {
  const model = dataAccessor.getModel();
  const { id, entityToSave } = options;
  if (!id) {
    throw new Error("Id is required when updating an entity.")
  }

  const entity = await findById(server, dataAccessor, id);
  if (!entity) {
    throw new Error(`${model.namespace}.${model.singularCode}  with id "${id}" was not found.`);
  }

  const changes = getEntityPartChanges(entity, entityToSave);
  if (!changes) {
    return entity;
  }

  const oneRelationPropertiesToUpdate: RpdDataModelProperty[] = [];
  const manyRelationPropertiesToUpdate: RpdDataModelProperty[] = [];
  keys(changes).forEach((propertyCode) => {
    const property = model.properties.find((e) => e.code === propertyCode);
    if (!property) {
      // Unknown property
      return;
    }

    if (isRelationProperty(property)) {
      if (property.relation === "many") {
        manyRelationPropertiesToUpdate.push(property);
      } else {
        oneRelationPropertiesToUpdate.push(property);
      }
    }
  })

  const row = mapEntityToDbRow(model, changes);
  oneRelationPropertiesToUpdate.forEach(property => {
    const fieldValue = changes[property.code];
    if (isObject(fieldValue)) {
      row[property.targetIdColumnName!] = fieldValue["id"];
    } else {
      row[property.targetIdColumnName!] = fieldValue;
    }
  })
  let updatedRow = row;
  if (Object.keys(row).length) {
    updatedRow = await dataAccessor.updateById(id, row);
  }
  const updatedEntity = Object.assign({}, entity, updatedRow);

  // save many-relation properties
  for (const property of manyRelationPropertiesToUpdate) {
    const relatedEntities: any[] = [];
    const targetDataAccessor = server.getDataAccessor({
      singularCode: property.targetSingularCode!,
    });

    const relatedEntitiesToBeSaved = changes[property.code];
    if (!isArray(relatedEntitiesToBeSaved)) {
      throw new Error(`Value of field '${property.code}' should be an array.`);
    }

    if (property.linkTableName) {
      // TODO: should support removing relation
      await server.queryDatabaseObject(`DELETE FROM ${server.queryBuilder.quoteTable({schema:property.linkSchema, tableName: property.linkTableName})} WHERE ${server.queryBuilder.quoteObject(property.selfIdColumnName!)} = $1`, [id]);
    }

    for (const relatedEntityToBeSaved of relatedEntitiesToBeSaved) {
      let relatedEntityId: any;
      if (isObject(relatedEntityToBeSaved)) {
        relatedEntityId = relatedEntityToBeSaved["id"];
        if (!relatedEntityId) {
          // related entity is to be created
          const targetEntity = relatedEntityToBeSaved;
          if (!property.linkTableName) {
            targetEntity[property.selfIdColumnName!] = id;
          }
          const newTargetEntity = await createEntity(server, targetDataAccessor, {
            entity: targetEntity,
          });

          if (property.linkTableName) {
            const command = `INSERT INTO ${server.queryBuilder.quoteTable({schema:property.linkSchema, tableName: property.linkTableName})} (${server.queryBuilder.quoteObject(property.selfIdColumnName!)}, ${property.targetIdColumnName}) VALUES ($1, $2) ON CONFLICT DO NOTHING;`
            const params = [id, newTargetEntity.id];
            await server.queryDatabaseObject(command, params);
          }

          relatedEntities.push(newTargetEntity);
        } else {
          // related entity is existed
          const targetEntity = await targetDataAccessor.findById(relatedEntityId);
          if (!targetEntity) {
            throw new Error(`Entity with id '${relatedEntityId}' in field '${property.code}' is not exists.`)
          }

          if (property.linkTableName) {
            const command = `INSERT INTO ${server.queryBuilder.quoteTable({schema:property.linkSchema, tableName: property.linkTableName})} (${server.queryBuilder.quoteObject(property.selfIdColumnName!)}, ${property.targetIdColumnName}) VALUES ($1, $2) ON CONFLICT DO NOTHING;`
            const params = [id, relatedEntityId];
            await server.queryDatabaseObject(command, params);
          } else {
            await targetDataAccessor.updateById(targetEntity.id, {[property.selfIdColumnName!]: id});
            targetEntity[property.selfIdColumnName!] = id;
          }
          relatedEntities.push(targetEntity);
        }
      } else {
        // fieldValue is id
        relatedEntityId = relatedEntityToBeSaved
        const targetEntity = await targetDataAccessor.findById(relatedEntityId);
        if (!targetEntity) {
          throw new Error(`Entity with id '${relatedEntityId}' in field '${property.code}' is not exists.`)
        }

        if (property.linkTableName) {
          const command = `INSERT INTO ${server.queryBuilder.quoteTable({schema:property.linkSchema, tableName: property.linkTableName})} (${server.queryBuilder.quoteObject(property.selfIdColumnName!)}, ${property.targetIdColumnName}) VALUES ($1, $2) ON CONFLICT DO NOTHING;`
          const params = [id, relatedEntityId];
          await server.queryDatabaseObject(command, params);
        } else {
          await targetDataAccessor.updateById(targetEntity.id, {[property.selfIdColumnName!]: id});
          targetEntity[property.selfIdColumnName!] = id;
        }

        relatedEntities.push(targetEntity);
      }
    }
    updatedEntity[property.code] = relatedEntities;
  }

  
  server.emitEvent(
    "entity.update",
    {
      namespace: model.namespace,
      modelSingularCode: model.singularCode,
      before: entity,
      after: updatedEntity,
      changes: changes,
    },
    plugin,
  );
  return updatedEntity;
}

export default class EntityManager<TEntity=any> {
  #server: IRpdServer;
  #dataAccessor: IRpdDataAccessor;

  constructor(server: IRpdServer, dataAccessor: IRpdDataAccessor) {
    this.#server = server;
    this.#dataAccessor = dataAccessor;
  }

  getModel(): RpdDataModel {
    return this.#dataAccessor.getModel();
  }

  async findEntities(options: FindEntityOptions): Promise<TEntity[]> {
    return await findEntities(this.#server, this.#dataAccessor, options);
  }

  async findEntity(options: FindEntityOptions): Promise<TEntity | null> {
    return await findEntity(this.#server, this.#dataAccessor, options);
  }

  async findById(id: any, keepNonPropertyFields: boolean = false): Promise<TEntity | null> {
    return await findById(this.#server, this.#dataAccessor, id, keepNonPropertyFields);
  }

  async createEntity(options: CreateEntityOptions, plugin?: RapidPlugin): Promise<TEntity> {
    const model = this.getModel();
    const newEntity = await createEntity(this.#server, this.#dataAccessor, options);

    this.#server.emitEvent(
      "entity.create",
      {
        namespace: model.namespace,
        modelSingularCode: model.singularCode,
        after: newEntity,
      },
      plugin,
    );

    return newEntity;
  }

  async updateEntityById(options: UpdateEntityByIdOptions, plugin?: RapidPlugin): Promise<TEntity> {
    return await updateEntityById(this.#server, this.#dataAccessor, options, plugin);
  }

  async count(options: CountEntityOptions): Promise<CountEntityResult> {
    return await this.#dataAccessor.count(options);
  }

  async deleteById(id: any, plugin?: RapidPlugin): Promise<void> {
    const model = this.getModel();
    const entity = await this.findById(id, true);
    if (!entity) {
      return;
    }

    await this.#dataAccessor.deleteById(id);
    this.#server.emitEvent(
      "entity.delete",
      {
        namespace: model.namespace,
        modelSingularCode: model.singularCode,
        before: entity,
      },
      plugin,
    );
  }

  async addRelations(options: AddEntityRelationsOptions, plugin?: RapidPlugin): Promise<void> {
    const model = this.getModel();
    const {id, property, relations} = options;
    const entity = await this.findById(id);
    if (!entity) {
      throw new Error(`${model.namespace}.${model.singularCode}  with id "${id}" was not found.`);
    }

    const relationProperty = model.properties.find(e => e.code === property);
    if (!relationProperty) {
      throw new Error(`Property '${property}' was not found in ${model.namespace}.${model.singularCode}`);
    }

    if (!(isRelationProperty(relationProperty) && relationProperty.relation === "many")) {
      throw new Error(`Operation 'addRelations' is only supported on property of 'many' relation`);
    }

    const server = this.#server;
    const { queryBuilder } = server;
    if (relationProperty.linkTableName) {
      for (const relation of relations) {
        const command = `INSERT INTO ${queryBuilder.quoteTable({schema:relationProperty.linkSchema, tableName: relationProperty.linkTableName})} (${queryBuilder.quoteObject(relationProperty.selfIdColumnName!)}, ${queryBuilder.quoteObject(relationProperty.targetIdColumnName!)})
    SELECT $1, $2 WHERE NOT EXISTS (
      SELECT ${queryBuilder.quoteObject(relationProperty.selfIdColumnName!)}, ${queryBuilder.quoteObject(relationProperty.targetIdColumnName!)}
        FROM ${queryBuilder.quoteTable({schema:relationProperty.linkSchema, tableName: relationProperty.linkTableName})}
        WHERE ${queryBuilder.quoteObject(relationProperty.selfIdColumnName!)}=$1 AND ${queryBuilder.quoteObject(relationProperty.targetIdColumnName!)}=$2
      )`;
        const params = [id, relation.id];
        await server.queryDatabaseObject(command, params);
      }
    }

    server.emitEvent(
      "entity.addRelations",
      {
        namespace: model.namespace,
        modelSingularCode: model.singularCode,
        entity,
        property,
        relations,
      },
      plugin,
    );
  }

  async removeRelations(options: RemoveEntityRelationsOptions, plugin?: RapidPlugin): Promise<void> {
    const model = this.getModel();
    const {id, property, relations} = options;
    const entity = await this.findById(id);
    if (!entity) {
      throw new Error(`${model.namespace}.${model.singularCode}  with id "${id}" was not found.`);
    }

    const relationProperty = model.properties.find(e => e.code === property);
    if (!relationProperty) {
      throw new Error(`Property '${property}' was not found in ${model.namespace}.${model.singularCode}`);
    }

    if (!(isRelationProperty(relationProperty) && relationProperty.relation === "many")) {
      throw new Error(`Operation 'removeRelations' is only supported on property of 'many' relation`);
    }

    const server = this.#server;
    const { queryBuilder } = server;
    if (relationProperty.linkTableName) {
      for (const relation of relations) {
        const command = `DELETE FROM ${queryBuilder.quoteTable({schema:relationProperty.linkSchema, tableName: relationProperty.linkTableName})}
    WHERE ${queryBuilder.quoteObject(relationProperty.selfIdColumnName!)}=$1 AND ${queryBuilder.quoteObject(relationProperty.targetIdColumnName!)}=$2;`;
        const params = [id, relation.id];
        await server.queryDatabaseObject(command, params);
      }
    }

    server.emitEvent(
      "entity.removeRelations",
      {
        namespace: model.namespace,
        modelSingularCode: model.singularCode,
        entity,
        property,
        relations,
      },
      plugin,
    );
  }
}
