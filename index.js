const fs = require("fs-extra");
const path = require("path");
const { execSync } = require("child_process");
const dotenv = require("dotenv");
const { Octokit } = require("@octokit/rest");
const { Configuration, OpenAIApi } = require("openai");

dotenv.config();
const configuration = new Configuration({
  apiKey: process.env.OPENAI_API_KEY,
});
const openai = new OpenAIApi(configuration);

const UNIQUE_DELIMITER = "|||GPT4_DELIMITER|||";
const octokit = new Octokit({ auth: process.env.GITHUB_ACCESS_TOKEN });

async function main() {
  const directory = process.cwd();

  const context =
    "You are working on a pull request for a project. You are midway through making changes according to the following Planned Changes. Included below is helpful context about the changes and the state of the code repository.";
  const request =
    "Parameterize the request so that we can pass it in as an argument";

  const gitStatus = execSync("git status", { encoding: "utf-8" });

  const gitTree = execSync("git ls-tree -r --name-only HEAD", {
    encoding: "utf-8",
  });

  const planningDetails = await getPlanningDetails({
    context,
    gitStatus,
    gitTree,
    request,
  });
  console.log(`Planning details: ${planningDetails}`);

  const {
    planned_changes: plannedChanges,
    required_file_reads: requiredFileReads,
    required_file_writes: requiredFileWrites,
    branch_name: branchName,
  } = JSON.parse(planningDetails);

  const filesToRead = [...requiredFileReads, ...requiredFileWrites];

  // Iterate through the required files
  for (const file of filesToRead) {
    console.log(`Processing file ${file}`);

    const filepath = path.join(directory, file);
    const fileContent = fs.readFileSync(filepath, "utf-8");

    const markdown = `### Context\n${context}\n\n### Planned Changes\n${plannedChanges}\n\n### Git Status\n${gitStatus}\n\n### Git Tree\n${gitTree}\n\n### File Content\n${fileContent}\n\n### Request\n${request}`;

    const result = await changeSingleFile(markdown);
    if (result.choices && result.choices.length > 0) {
      const [newContent, summary] = result.choices[0].message.content
        .split(UNIQUE_DELIMITER)
        .map((s) => s.trim());

      console.log(`Writing new content to ${filepath}...`);
      fs.writeFileSync(filepath, newContent, "utf-8");

      // Write the summary to the parallel directory
      const summaryPath = path.join(directory, ".gpt-pr", file);

      console.log(`Writing summary to ${summaryPath}`);
      fs.ensureFileSync(summaryPath);
      fs.writeFileSync(summaryPath, summary, "utf-8");
    }
  }

  console.log("Committing changes and creating a new branch");

  const commitMessage = `gpt-pr update to ${branchName}}`;

  try {
    // Checkout a new branch
    console.log(`Checking out a new branch ${branchName}`);
    execSync(`git checkout -b ${branchName}`, { encoding: "utf-8" });

    // Add changes to the staging area
    console.log("Adding changes to the staging area");
    execSync("git add .", { encoding: "utf-8" });

    // Commit the changes
    console.log(`Committing the changes with message "${commitMessage}"`);
    execSync(`git commit -m "${commitMessage}"`, { encoding: "utf-8" });

    // Push the new branch to the remote repository
    console.log(
      `Pushing the new branch ${branchName} to the remote repository`
    );
    execSync(`git push origin ${branchName}`, { encoding: "utf-8" });

    console.log(
      `Successfully created a new branch '${branchName}' and pushed the changes.`
    );

    const owner = "irl-dan";
    const repo = "gpt-pr";
    const baseBranch = "main";
    const prTitle = `gpt-pr changes for ${branchName}`;
    const prBody = plannedChanges;

    console.log(
      `Creating a pull request with title "${prTitle}" and body "${prBody}"`
    );
    createPullRequest(owner, repo, branchName, baseBranch, prTitle, prBody);
  } catch (error) {
    console.error(
      "Error while committing changes and creating a new branch:",
      error
    );
  }
}

async function getPlanningDetails({ context, gitStatus, gitTree, request }) {
  const systemPrompt =
    "As GPT-4, you are an expert in software development and code analysis. Review the context, git status, and git tree, and provide a detailed plan to improve the code.";

  const userPrompt = `Given the context:

${context}

Git Status:

${gitStatus}

Git Tree Structure:

${gitTree}

${request}

Analyze the codebase and provide a JSON object with the keys "branch_name", "planned_changes", "required_file_reads", and "required_file_writes", describing the specific improvements and modifications needed to optimize the code and fix potential issues. Make sure the recommendations are precise, relevant, and actionable. Use snake case to name the branch something concise and relevant, use 30-40 characters`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  const response = chat(messages);
}

async function chat(messages) {
  console.log(
    `=====================Local to GPT-4>>>>>>>>>>>>>>>>>>>>>\n\n${userPrompt}========================================================`
  );
  const response = await openai.createChatCompletion({
    model: "gpt-4",
    messages,
    temperature: 1,
    n: 1,
  });

  const content = response.data.choices[0].message.content;

  console.log(
    `<<<<<<<<<<<<<<<<<<<<<<GPT-4 to Local:\n\n=====================${content}========================================================`
  );

  return content;
}

async function changeSingleFile(markdown) {
  const systemPrompt =
    "As GPT-4, you are an expert in software development and code analysis. Follow the request at the bottom to provide insightful recommendations and helpful fixes for the code. Make changes to files only when it is essential for improving the code quality or fixing issues.";

  const userPrompt = `Given the stuffed markdown context:

${markdown}

Carefully analyze the code and provide a recommended file change that addresses any issues, optimizes the code, or enhances its functionality. Ensure that your recommendations are precise, relevant, and actionable. Respond with the new file contents, followed by the unique delimiter:

${UNIQUE_DELIMITER}

Then, provide a compact pseudocode interface summary of the new version of the file, including public classes, method signatures, exported function signatures, and any other useful information for an external file import. This summary should be as compact as possible while still giving insight into the public-facing interfaces within the file.`;

  const response = await openai.createChatCompletion({
    model: "gpt-4",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 1,
    n: 1,
  });

  return response.data;
}

async function createPullRequest(owner, repo, head, base, title, body) {
  try {
    const response = await octokit.rest.pulls.create({
      owner,
      repo,
      head,
      base,
      title,
      body,
    });

    if (response.status === 201) {
      console.log(
        `Pull request created successfully: ${response.data.html_url}`
      );
      return response.data.html_url;
    } else {
      console.error("Error creating pull request:", response);
      return null;
    }
  } catch (error) {
    console.error("Error creating pull request:", error);
    return null;
  }
}

main()
  .then(() => console.log("Success!"))
  .catch((error) => console.error("Error:", error));
