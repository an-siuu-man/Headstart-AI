import { addDays, subHours } from "date-fns";

type User = {
  id: string;
  name: string;
  email: string;
  avatarUrl?: string;
};

type Course = {
  id: string;
  name: string;
  code: string;
  color: string;
};

type Assignment = {
  id: string;
  title: string;
  courseId: string;
  dueDate: string;
  priority: "High" | "Medium" | "Low";
  status: "Pending" | "In Progress" | "Completed";
  points: number;
};

type Stat = {
  label: string;
  value: string | number;
  change: string;
  trend: "up" | "down" | "neutral";
};

type GeneratedGuide = {
  id: string;
  title: string;
  courseId: string;
  assignmentId: string;
  generatedAt: string;
  status: "Ready" | "Refreshing";
};

export const currentUser: User = {
  id: "user_1",
  name: "Alex Student",
  email: "alex@university.edu",
  avatarUrl: "https://github.com/shadcn.png",
};

export const courses: Course[] = [
  { id: "c1", name: "Introduction to Artificial Intelligence", code: "CS 482", color: "bg-blue-500" },
  { id: "c2", name: "Web Systems", code: "CS 493", color: "bg-green-500" },
  { id: "c3", name: "Database Management Systems", code: "CS 460", color: "bg-purple-500" },
  { id: "c4", name: "Linear Algebra", code: "MATH 201", color: "bg-orange-500" },
];

export const assignments: Assignment[] = [
  {
    id: "a1",
    title: "Neural Network Implementation",
    courseId: "c1",
    dueDate: addDays(new Date(), 2).toISOString(),
    priority: "High",
    status: "In Progress",
    points: 100,
  },
  {
    id: "a2",
    title: "React Component Lifecycle",
    courseId: "c2",
    dueDate: addDays(new Date(), 5).toISOString(),
    priority: "Medium",
    status: "Pending",
    points: 50,
  },
  {
    id: "a3",
    title: "SQL Query Optimization",
    courseId: "c3",
    dueDate: addDays(new Date(), 1).toISOString(),
    priority: "High",
    status: "Pending",
    points: 75,
  },
  {
    id: "a4",
    title: "Vector Spaces Quiz",
    courseId: "c4",
    dueDate: subHours(new Date(), 4).toISOString(), // Past due slightly
    priority: "Medium",
    status: "Completed",
    points: 20,
  },
  {
    id: "a5",
    title: "Final Project Proposal",
    courseId: "c2",
    dueDate: addDays(new Date(), 14).toISOString(),
    priority: "Low",
    status: "Pending",
    points: 100,
  },
];

export const stats: Stat[] = [
  { label: "Pending Assignments", value: 3, change: "-1", trend: "down" },
  { label: "Upcoming Deadlines", value: 2, change: "Within 48h", trend: "neutral" },
  { label: "Average Grade", value: "92%", change: "+2%", trend: "up" },
  { label: "Study Hours", value: "14h", change: "+4h", trend: "up" },
];

export const generatedGuides: GeneratedGuide[] = [
  {
    id: "g1",
    title: "Neural Network Implementation Guide",
    courseId: "c1",
    assignmentId: "a1",
    generatedAt: subHours(new Date(), 1).toISOString(),
    status: "Ready",
  },
  {
    id: "g2",
    title: "SQL Query Optimization Walkthrough",
    courseId: "c3",
    assignmentId: "a3",
    generatedAt: subHours(new Date(), 6).toISOString(),
    status: "Ready",
  },
  {
    id: "g3",
    title: "React Component Lifecycle Notes",
    courseId: "c2",
    assignmentId: "a2",
    generatedAt: subHours(new Date(), 22).toISOString(),
    status: "Refreshing",
  },
  {
    id: "g4",
    title: "Vector Spaces Quiz Prep Sheet",
    courseId: "c4",
    assignmentId: "a4",
    generatedAt: subHours(new Date(), 40).toISOString(),
    status: "Ready",
  },
];

export function getCourse(id: string): Course | undefined {
  return courses.find((c) => c.id === id);
}

export async function fetchDashboardData() {
  // Simulate network delay
  await new Promise((resolve) => setTimeout(resolve, 500));
  return {
    user: currentUser,
    stats,
    upcomingAssignments: assignments
      .filter((a) => a.status !== "Completed")
      .sort((a, b) => new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime())
      .slice(0, 6),
    generatedGuides: generatedGuides
      .slice()
      .sort((a, b) => new Date(b.generatedAt).getTime() - new Date(a.generatedAt).getTime())
      .slice(0, 6),
  };
}
