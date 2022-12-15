const fetch = require("node-fetch");
const fs = require("fs");
const swaggerPaths = require("./swagger/paths.json");

const apiReferenceConfigFile = "./docs/configs/api-reference/configs.json";

let swaggerSchemas;
let swaggerOAS = {};

const camelToSnakeCase = (str) => {
  return (str.charAt(0).toLowerCase() + str.slice(1)).replace(
    /[A-Z]/g,
    (letter) => `-${letter.toLowerCase()}`
  );
};

/**
 * @name translateSchemaReference
 * @description This function translate a schema in OAS to its JSON format
 */
const translateSchemaReference = (schemaRef) => {
  const schemaName = schemaRef.replace("#/components/schemas/", "");
  const schemaJSON = swaggerSchemas[schemaName];

  const { type, example, enum: schemaEnum, properties } = schemaJSON;
  if (type) {
    return {
      type: type === "integer" ? "number" : type,
      example,
      enum: schemaEnum,
    };
  } else if (properties) {
    return {
      type: "object",
      fields: Object.keys(properties).map((name) => {
        const { type, description, example, items } = properties[name];
        if (type === "array") {
          return {
            name,
            type: type === "integer" ? "number" : type,
            description,
            example,
            ...(items && items?.$ref
              ? // If there are more arrays within the child, do recursion
                translateSchemaReference(items?.$ref)
              : { items }),
          };
        } else {
          return {
            name,
            type: type === "integer" ? "number" : type,
            description,
            example,
          };
        }
      }),
    };
  } else {
    return {};
  }
};

const extractSwaggerValueByMethod = (swaggerJSON, path) => {
  const method = Object.keys(swaggerJSON.paths?.[path])[0];
  return {
    ...swaggerJSON.paths?.[path]?.[method],
    method: method.toUpperCase(),
  };
};

const formatParameters = (parameters) => {
  const queryParams = [];
  const pathParams = [];
  for (let param of parameters) {
    const { name, description, required, schema } = param ?? {};
    const { example, type, $ref, items } = schema ?? {};
    const paramsObject = {
      name,
      description,
      required,
      example,
      ...(type
        ? {
            type: type === "integer" ? "number" : type,
            ...(items &&
              (items?.$ref
                ? {
                    fields: translateSchemaReference(items?.$ref),
                  }
                : { field: items })),
          }
        : translateSchemaReference($ref)),
    };
    switch (param.in) {
      case "query":
        queryParams.push(paramsObject);
        break;
      case "path":
      default:
        pathParams.push(paramsObject);
        break;
    }
  }
  return { pathParams, queryParams };
};

const formatResponses = (responses) => {
  const formattedResponses = Object.keys(responses).map((status) => {
    const { description, content } = responses[status];
    const schemaRef = content?.["application/json"]?.schema?.$ref;
    return {
      status,
      description,
      ...(schemaRef
        ? {
            body: translateSchemaReference(
              content["application/json"]?.schema?.$ref
            ),
          }
        : {}),
    };
  });
  return formattedResponses;
};

/**
 * @name formatPath
 * @description Format given swagger path to modified path, replacing / with :
 * @example
 * const formattedPath = formatPath(path);
 *
 * @param path path that is going to be modified
 * @returns returning formatted path for API reference
 */
const formatPath = (path) => {
  const pathArray = path.split("/");
  const formattedPathArray = pathArray
    .slice(1, pathArray.length)
    .map((p) => p.replace(/[{]/g, ":").replace(/[}]/g, ""));
  return `/${formattedPathArray.join("/")}`;
};

/**
 * @name formatSwaggerJSON
 * @description This function formats standard swagger OAS JSON to
 * custom format for API reference docs
 *
 * @example
 * const res = formatSwaggerJSON(swaggerJSON);
 *
 * @param swaggerJSON standard swagger OAS JSON
 * @returns formatted swagger OAS JSON for API Reference
 */
const formatSwaggerJSON = (swaggerJSON, apiHost) => {
  const swaggerContent = {};
  for (let path in swaggerJSON.paths) {
    // Extract all important fields from Swagger
    const {
      operationId,
      description,
      summary,
      method,
      parameters = [],
      responses = [],
    } = extractSwaggerValueByMethod(swaggerJSON, path);

    // Formatting Parameters & Responses
    const { pathParams = [], queryParams = [] } = formatParameters(parameters);
    const formattedResponses = formatResponses(responses);
    const formattedPath = formatPath(path);

    swaggerContent[operationId] = {
      apiHost,
      summary,
      description,
      method,
      path: formattedPath,
      pathParams,
      queryParams,
      responses: formattedResponses,
    };
  }
  return swaggerContent;
};

/**
 * @name generateConfigs
 * @description
 * Generate JSON config for API Reference & write it to JSON file.
 * This already works well for:
 * - NFT API
 * - Token API
 * - Balance API
 * - Transaction API
 * - Block API
 * - Events API
 * - Utils API
 * - Resolve API
 * - DeFi API
 * - IPFS API
 * - Streams API
 * - Auth API
 * - Solana API
 *
 * @example
 * const configs = await generateConfigs();
 *
 * @returns Generated JSON config
 */
const generateConfigs = async () => {
  try {
    for (let key in swaggerPaths) {
      const swaggerRes = await fetch(swaggerPaths[key].swaggerPath);
      const swaggerJSON = await swaggerRes?.json();
      let swaggerContent;

      // Store Swagger Schema for global usage
      swaggerSchemas = swaggerJSON.components.schemas;

      const apiHost = swaggerJSON.servers?.[0]?.url;

      // If statement is temporary, for testing only
      swaggerContent = formatSwaggerJSON(swaggerJSON, apiHost);
      swaggerOAS[key] = swaggerContent;
    }

    // Write API reference Config
    await fs.writeFile(
      apiReferenceConfigFile,
      JSON.stringify(swaggerOAS),
      "utf8",
      () => {}
    );

    for (let key in swaggerOAS) {
      if (!["nft"].includes(key)) {
        for (let index in Object.keys(swaggerOAS[key])) {
          const functionName = Object.keys(swaggerOAS[key])[index];
          const snakeCaseFunctionName = camelToSnakeCase(functionName);

          // Write MDX Files for API Reference pages
          await fs.writeFile(
            `${swaggerPaths[key].filePath}/${snakeCaseFunctionName}.mdx`,
            `---
sidebar_position: ${index}
sidebar_label: ${swaggerOAS[key][functionName]?.summary}
slug: /reference/${functionName.toLowerCase()}
---

import ApiReference from "@site/src/components/ApiReference";
import config from "${swaggerPaths[key].importPath}";

# ${swaggerOAS[key][functionName]?.summary}

<ApiReference {...config.${key}.${functionName}} />
              `,
            { flag: "w" },
            (err) => {
              if (err) {
                return console.log(err);
              }
              console.log("The file was saved!");
            }
          );
        }
      }
    }
  } catch (e) {
    console.error(e);
  }
};

generateConfigs();
