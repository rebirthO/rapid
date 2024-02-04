import { IPluginInstance } from "~/types";
import { setCookie } from "~/deno-std/http/cookie";
import { createJWT } from "~/utilities/jwtUtility";
import { HttpHandlerContext } from "~/core/httpHandler";

export interface UserAccessToken {
  sub: "userAccessToken",
  aud: string;
}

export const code = "createSession";

export async function handler(
  plugin: IPluginInstance,
  ctx: HttpHandlerContext,
  options: any,
) {
  const { server, input, routerContext } = ctx;
  const { response } = routerContext;
  const { account, password } = input;

  const userDataAccessor = server.getDataAccessor({
    singularCode: "oc_user",
  });

  const user = await userDataAccessor.findOne({
    filters: [
      {
        operator: "eq",
        field: "login",
        value: account,
      }
    ]
  });

  if (!user) {
    throw new Error("Wrong account or password.");
  }

  const token = await createJWT({
    iss: "authManager",
    sub: "userAccessToken",
    aud: "" + user.id,
    iat: new Date,
    act: user.login,
  } as UserAccessToken);

  setCookie(response.headers, {
    name: ctx.server.config.sessionCookieName,
    value: token,
    path: "/",
  });

  ctx.output = {
    token,
  };
}