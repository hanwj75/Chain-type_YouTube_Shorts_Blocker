export const createInitialVotes = () => {
  return [
    { voterId: "B", choice: "APPROVE" as const },
    { voterId: "C", choice: "REJECT" as const },
  ];
};
