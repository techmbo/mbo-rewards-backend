import { Prisma } from "@prisma/client";

export function isPrismaUniqueViolation(error) {
  return (
    (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") ||
    error?.code === "P2002"
  );
}
